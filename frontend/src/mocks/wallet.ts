import type {
  AdminWalletStats,
  PricingChange,
  PricingResponse,
  UserSpendStats,
  WalletAccount,
  WalletDailyPoint,
  WalletListItem,
  WalletTransaction,
} from '@/types/wallet';

/** Development fixtures (VITE_USE_MOCK=true): amounts in micro-euros. */

function series(days: number, base: number): WalletDailyPoint[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const calls = (i * 7) % 11;
    return {
      date: d.toISOString().slice(0, 10),
      amount: String(calls * base),
      count: calls,
    };
  });
}

export const MOCK_WALLET: WalletAccount = {
  balance: '3482150',
  isUnlimited: false,
  canSpend: true,
  currency: 'eur',
};

export const MOCK_TRANSACTIONS: WalletTransaction[] = Array.from({ length: 28 }, (_, i) => {
  const at = new Date(Date.now() - i * 3_600_000 * 5).toISOString();
  if (i === 27) {
    return {
      id: `tx-${i}`, type: 'topup' as const, amount: '5000000', delta: '5000000',
      balanceAfter: '5000000', applicationId: null,
      metadata: { source: 'manual', reference: 'INV-2026-001' }, createdAt: at,
    };
  }
  const mcp = i % 6 === 0;
  const cost = String(-(1200 + ((i * 937) % 9000)));
  return {
    id: `tx-${i}`, type: 'usage' as const, amount: cost, delta: cost,
    balanceAfter: String(3482150 + (27 - i) * 1800), applicationId: 'app-1',
    metadata: mcp
      ? { kind: 'mcp', mcpServer: 'search', tool: 'web_search', applicationSlug: 'chat-app' }
      : { kind: 'llm', model: 'gpt-4o-mini', totalTokens: 400 + i * 37, applicationSlug: 'chat-app' },
    createdAt: at,
  };
});

export const MOCK_USER_STATS: UserSpendStats = {
  days: 30,
  total: '1517850',
  calls: 212,
  series: series(30, 2400),
  byApplication: [
    { applicationId: 'app-1', name: 'Chat App', slug: 'chat-app', amount: '1204000', count: 170 },
    { applicationId: 'app-2', name: 'Docs Assistant', slug: 'docs', amount: '313850', count: 42 },
  ],
  byKind: [
    { kind: 'llm', amount: '1300000', count: 190 },
    { kind: 'mcp', amount: '217850', count: 22 },
  ],
};

export const MOCK_ADMIN_STATS: AdminWalletStats = {
  days: 30,
  totals: {
    accounts: 14, accountsInDebt: 2, unlimitedAccounts: 1,
    outstandingCredit: '48250000', outstandingDebt: '730000',
  },
  spend: { total: '12480000', calls: 1830, series: series(30, 21000) },
  topUps: { total: '40000000', count: 9, series: series(30, 0) },
  topConsumers: [
    { ownerType: 'user', ownerId: 'u1', name: 'Alice Martin', email: 'alice@example.com', amount: '4200000', count: 610 },
    { ownerType: 'user', ownerId: 'u2', name: 'Bob Durand', email: 'bob@example.com', amount: '2900000', count: 402 },
  ],
  byApplication: MOCK_USER_STATS.byApplication,
  byKind: MOCK_USER_STATS.byKind,
};

export const MOCK_WALLET_LIST: WalletListItem[] = [
  { id: 'w1', ownerType: 'user', ownerId: 'u1', name: 'Alice Martin', email: 'alice@example.com', balance: '3482150', isUnlimited: false, canSpend: true, spent30d: '4200000', updatedAt: new Date().toISOString() },
  { id: 'w2', ownerType: 'user', ownerId: 'u2', name: 'Bob Durand', email: 'bob@example.com', balance: '-420000', isUnlimited: false, canSpend: false, spent30d: '2900000', updatedAt: new Date().toISOString() },
  { id: 'w3', ownerType: 'user', ownerId: 'u3', name: 'Dave Staff', email: 'dave@example.com', balance: '0', isUnlimited: true, canSpend: true, spent30d: '180000', updatedAt: new Date().toISOString() },
];

const MOCK_CHANGES: PricingChange[] = [
  { id: 'p2', usdToEurRate: '0.92', marginPercent: 20, reason: 'Monthly rate update', actor: { id: 'a1', name: 'Alexandre Dubois' }, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  { id: 'p1', usdToEurRate: '0.9', marginPercent: 15, reason: 'Initial pricing', actor: { id: 'a1', name: 'Alexandre Dubois' }, createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() },
];

export const MOCK_PRICING: PricingResponse = {
  current: { usdToEurRate: '0.92', marginPercent: 20, source: 'database', change: MOCK_CHANGES[0]! },
  history: MOCK_CHANGES,
};
