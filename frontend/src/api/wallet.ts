import { apiFetch, USE_MOCK } from './client';
import type {
  AdminWalletStats,
  TopupOptions,
  UserSpendStats,
  WalletAccount,
  WalletListFilter,
  WalletListResponse,
  WalletOperationResponse,
  WalletTransactionPage,
  WalletTransactionType,
} from '@/types/wallet';
import {
  MOCK_ADMIN_STATS,
  MOCK_TRANSACTIONS,
  MOCK_USER_STATS,
  MOCK_WALLET,
  MOCK_WALLET_LIST,
} from '@/mocks/wallet';

const PAGE = 20;

interface TransactionQuery {
  cursor?: string
  limit?: number
  type?: WalletTransactionType
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

function mockPage(params: TransactionQuery): WalletTransactionPage {
  const start = params.cursor ? Number(params.cursor) : 0;
  const limit = params.limit ?? PAGE;
  const items = MOCK_TRANSACTIONS
    .filter((t) => !params.type || t.type === params.type)
    .slice(start, start + limit);
  const next = start + limit;
  return { items, nextCursor: next < MOCK_TRANSACTIONS.length ? String(next) : null };
}

// ── The signed-in user's own wallet ───────────────────────────────────────────

export async function getMyWallet(): Promise<WalletAccount> {
  if (USE_MOCK) return { ...MOCK_WALLET };
  return apiFetch<WalletAccount>('/user/wallet');
}

export async function getMyTransactions(params: TransactionQuery = {}): Promise<WalletTransactionPage> {
  if (USE_MOCK) return mockPage(params);
  return apiFetch<WalletTransactionPage>(`/user/wallet/transactions${query({ ...params })}`);
}

export async function getMySpendStats(days = 30): Promise<UserSpendStats> {
  if (USE_MOCK) return { ...MOCK_USER_STATS, days };
  return apiFetch<UserSpendStats>(`/user/wallet/stats${query({ days })}`);
}

export async function getTopupOptions(): Promise<TopupOptions> {
  if (USE_MOCK) return { enabled: true, currency: 'eur', minCents: 500, maxCents: 50000 };
  return apiFetch<TopupOptions>('/user/wallet/topup-options');
}

export async function createCheckout(amountCents: number): Promise<{ url: string }> {
  if (USE_MOCK) return { url: '/profile?topup=success' };
  return apiFetch<{ url: string }>('/user/wallet/checkout', {
    method: 'POST',
    body: JSON.stringify({ amountCents }),
  });
}

// ── Administration ────────────────────────────────────────────────────────────

export async function listWallets(params: {
  page?: number
  limit?: number
  search?: string
  filter?: WalletListFilter
} = {}): Promise<WalletListResponse> {
  if (USE_MOCK) {
    const wallets = MOCK_WALLET_LIST.filter((w) => {
      if (params.filter === 'debt') return BigInt(w.balance) < 0n;
      if (params.filter === 'credit') return BigInt(w.balance) > 0n && !w.isUnlimited;
      if (params.filter === 'unlimited') return w.isUnlimited;
      return true;
    });
    return { wallets, total: wallets.length, page: params.page ?? 1, limit: params.limit ?? PAGE };
  }
  return apiFetch<WalletListResponse>(`/admin/wallets${query({ ...params })}`);
}

export async function getWalletStats(days = 30): Promise<AdminWalletStats> {
  if (USE_MOCK) return { ...MOCK_ADMIN_STATS, days };
  return apiFetch<AdminWalletStats>(`/admin/wallets/stats${query({ days })}`);
}

export async function getUserWallet(userId: string): Promise<WalletAccount> {
  if (USE_MOCK) return { ...MOCK_WALLET };
  return apiFetch<WalletAccount>(`/admin/wallets/users/${encodeURIComponent(userId)}`);
}

export async function getUserTransactions(
  userId: string,
  params: TransactionQuery = {},
): Promise<WalletTransactionPage> {
  if (USE_MOCK) return mockPage(params);
  return apiFetch<WalletTransactionPage>(
    `/admin/wallets/users/${encodeURIComponent(userId)}/transactions${query({ ...params })}`,
  );
}

export async function getUserSpendStatsAdmin(userId: string, days = 30): Promise<UserSpendStats> {
  if (USE_MOCK) return { ...MOCK_USER_STATS, days };
  return apiFetch<UserSpendStats>(
    `/admin/wallets/users/${encodeURIComponent(userId)}/stats${query({ days })}`,
  );
}

async function post(userId: string, action: string, body: unknown): Promise<WalletOperationResponse> {
  if (USE_MOCK) {
    return { transaction: MOCK_TRANSACTIONS[0]!, replayed: false };
  }
  return apiFetch<WalletOperationResponse>(
    `/admin/wallets/users/${encodeURIComponent(userId)}/${action}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Credit bought outside Stripe, against an invoice or transfer reference. */
export function recordTopup(
  userId: string,
  body: { amount: string; reference: string; idempotencyKey: string },
): Promise<WalletOperationResponse> {
  return post(userId, 'topups', body);
}

/** Credit given for free (promotion, compensation). */
export function grantCredit(
  userId: string,
  body: { amount: string; reason: string; idempotencyKey: string },
): Promise<WalletOperationResponse> {
  return post(userId, 'grants', body);
}

/** Signed correction: a negative amount removes credit. */
export function adjustBalance(
  userId: string,
  body: { amount: string; reason: string; idempotencyKey: string },
): Promise<WalletOperationResponse> {
  return post(userId, 'adjustments', body);
}

export async function setUnlimited(
  userId: string,
  body: { isUnlimited: boolean; reason: string },
): Promise<WalletAccount> {
  if (USE_MOCK) return { ...MOCK_WALLET, isUnlimited: body.isUnlimited, canSpend: true };
  return apiFetch<WalletAccount>(
    `/admin/wallets/users/${encodeURIComponent(userId)}/unlimited`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}
