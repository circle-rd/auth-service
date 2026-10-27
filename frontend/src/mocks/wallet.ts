import type {
  AdminWalletStats,
  PricingChange,
  PricingResponse,
  UserSpendStats,
  WalletAccount,
  WalletDailyPoint,
  WalletListItem,
  WalletModelEntry,
  WalletSpendDay,
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

const MOCK_BY_MODEL: WalletModelEntry[] = [
  { model: 'gpt-4o-mini', amount: '960000', count: 140, promptTokens: 184000, completionTokens: 62000, totalTokens: 246000 },
  { model: 'claude-haiku', amount: '340000', count: 50, promptTokens: 52000, completionTokens: 21000, totalTokens: 73000 },
  { model: 'mcp', amount: '217850', count: 22, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
];

function mockDaily(days: number): WalletSpendDay[] {
  return series(days, 2400).map((p, i) => {
    const total = Number(p.amount);
    if (total === 0) {
      return { date: p.date, amount: p.amount, count: 0, byApplication: [], byModel: [] };
    }
    const chat = Math.round(total * 0.7);
    const gpt = Math.round(total * 0.6);
    return {
      date: p.date,
      amount: p.amount,
      count: p.count,
      byApplication: [
        { applicationId: 'app-1', name: 'Chat App', slug: 'chat-app', amount: String(chat), count: p.count },
        { applicationId: 'app-2', name: 'Docs Assistant', slug: 'docs', amount: String(total - chat), count: Math.max(1, p.count - 1) },
      ],
      byModel: [
        { model: 'gpt-4o-mini', amount: String(gpt), count: p.count, promptTokens: 300 + i * 10, completionTokens: 120 + i * 5, totalTokens: 420 + i * 15 },
        { model: 'claude-haiku', amount: String(total - gpt), count: 1, promptTokens: 100, completionTokens: 40, totalTokens: 140 },
      ],
    };
  });
}

export const MOCK_USER_STATS: UserSpendStats = {
  days: 30,
  total: '1517850',
  notBilled: '0',
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
  byModel: MOCK_BY_MODEL,
  daily: mockDaily(30),
};

export const MOCK_ADMIN_STATS: AdminWalletStats = {
  days: 30,
  totals: {
    accounts: 14, accountsInDebt: 2, unlimitedAccounts: 1,
    outstandingCredit: '48250000', outstandingDebt: '730000',
  },
  spend: { total: '12480000', notBilled: '1900000', calls: 1830, series: series(30, 21000) },
  topUps: { total: '40000000', count: 9, series: series(30, 0) },
  topConsumers: [
    { ownerType: 'user', ownerId: 'u1', name: 'Emma Laurent', email: 'emma.laurent@example.com', amount: '6420000', count: 910 },
    { ownerType: 'user', ownerId: 'u2', name: 'Lucas Bernard', email: 'lucas.bernard@example.com', amount: '4200000', count: 610 },
    { ownerType: 'user', ownerId: 'u4', name: 'Hugo Petit', email: 'hugo.petit@example.com', amount: '2900000', count: 402 },
    { ownerType: 'user', ownerId: 'u3', name: 'Chloé Moreau', email: 'chloe.moreau@example.com', amount: '1830000', count: 255 },
    { ownerType: 'user', ownerId: 'u5', name: 'Inès Roux', email: 'ines.roux@example.com', amount: '1210000', count: 171 },
  ],
  byApplication: MOCK_USER_STATS.byApplication,
  byKind: MOCK_USER_STATS.byKind,
  byModel: MOCK_BY_MODEL,
};

const WALLET_ROWS: Array<[string, string, string, string, string, boolean]> = [
  ['Emma Laurent', 'emma.laurent@example.com', '12480000', '6420000', '0', false],
  ['Lucas Bernard', 'lucas.bernard@example.com', '3482150', '4200000', '0', false],
  ['Chloé Moreau', 'chloe.moreau@example.com', '25000000', '1830000', '0', false],
  ['Hugo Petit', 'hugo.petit@example.com', '-420000', '2900000', '0', false],
  ['Inès Roux', 'ines.roux@example.com', '880000', '1210000', '0', false],
  ['Noah Fournier', 'noah.fournier@example.com', '0', '180000', '0', true],
  ['Jade Girard', 'jade.girard@example.com', '5600000', '760000', '0', false],
  ['Louis Bonnet', 'louis.bonnet@example.com', '-310000', '540000', '0', false],
];

export const MOCK_WALLET_LIST: WalletListItem[] = WALLET_ROWS.map(([name, email, balance, spent30d, , unlimited], i) => ({
  id: `w${i + 1}`,
  ownerType: 'user',
  ownerId: `u${i + 1}`,
  name,
  email,
  balance,
  isUnlimited: unlimited,
  canSpend: unlimited || BigInt(balance) > 0n,
  spent30d,
  updatedAt: new Date(Date.now() - i * 3_600_000 * 5).toISOString(),
}));

const MOCK_CHANGES: PricingChange[] = [
  { id: 'p2', usdToEurRate: '0.92', marginPercent: 20, reason: 'Monthly rate update', actor: { id: 'a1', name: 'Alexandre Dubois' }, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  { id: 'p1', usdToEurRate: '0.9', marginPercent: 15, reason: 'Initial pricing', actor: { id: 'a1', name: 'Alexandre Dubois' }, createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() },
];

export const MOCK_PRICING: PricingResponse = {
  current: { usdToEurRate: '0.92', marginPercent: 20, source: 'database', change: MOCK_CHANGES[0]! },
  history: MOCK_CHANGES,
};
