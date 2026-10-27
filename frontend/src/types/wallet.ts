/** Amounts are micro-euro strings (1 EUR = 1 000 000); see `utils/money.ts`. */

export interface WalletAccount {
  balance: string
  isUnlimited: boolean
  /** Whether new spending is allowed: unlimited, or a strictly positive balance. */
  canSpend: boolean
  currency: 'eur'
}

export type WalletTransactionType =
  'topup' | 'grant' | 'refund' | 'usage' | 'adjust' | 'reversal'

export type WalletTransaction = {
  id: string
  type: WalletTransactionType
  /** Signed value of the operation. */
  amount: string
  /** Effect on the balance: 0 for usage on an unlimited account. */
  delta: string
  balanceAfter: string
  applicationId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface WalletTransactionPage {
  items: WalletTransaction[]
  nextCursor: string | null
}

export interface TopupOptions {
  enabled: boolean
  currency: 'eur'
  minCents: number
  maxCents: number
}

export interface WalletDailyPoint {
  date: string
  amount: string
  count: number
}

export interface WalletBreakdownEntry {
  applicationId: string | null
  name: string | null
  slug: string | null
  amount: string
  count: number
}

export interface WalletKindEntry {
  kind: string
  amount: string
  count: number
}

export interface WalletModelEntry {
  /** Model name; `mcp` for tool calls, `other` when the gateway did not report one. */
  model: string
  amount: string
  count: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** One day of spend, split by application and by model. */
export interface WalletSpendDay {
  date: string
  amount: string
  count: number
  byApplication: WalletBreakdownEntry[]
  byModel: WalletModelEntry[]
}

export interface UserSpendStats {
  days: number
  total: string
  /** Part of `total` that was never deducted (usage on an unlimited account). */
  notBilled: string
  calls: number
  series: WalletDailyPoint[]
  byApplication: WalletBreakdownEntry[]
  byKind: WalletKindEntry[]
  byModel: WalletModelEntry[]
  /** Per-day breakdown, the granularity the wallet views show by default. */
  daily: WalletSpendDay[]
}

export interface WalletTopConsumer {
  ownerType: string
  ownerId: string
  name: string | null
  email: string | null
  amount: string
  count: number
}

export interface AdminWalletStats {
  days: number
  totals: {
    accounts: number
    accountsInDebt: number
    unlimitedAccounts: number
    outstandingCredit: string
    outstandingDebt: string
  }
  spend: { total: string; notBilled: string; calls: number; series: WalletDailyPoint[] }
  topUps: { total: string; count: number; series: WalletDailyPoint[] }
  topConsumers: WalletTopConsumer[]
  byApplication: WalletBreakdownEntry[]
  byKind: WalletKindEntry[]
  byModel: WalletModelEntry[]
}

export type WalletListFilter = 'all' | 'debt' | 'credit' | 'unlimited'

export interface WalletListItem {
  id: string
  ownerType: string
  ownerId: string
  name: string | null
  email: string | null
  balance: string
  isUnlimited: boolean
  canSpend: boolean
  spent30d: string
  updatedAt: string
}

export interface WalletListResponse {
  wallets: WalletListItem[]
  total: number
  page: number
  limit: number
}

export interface WalletOperationResponse {
  transaction: WalletTransaction
  replayed: boolean
}

export interface PricingChange {
  id: string
  /** Euros per US dollar, plain decimal. */
  usdToEurRate: string
  marginPercent: number
  reason: string
  actor: { id: string; name: string | null }
  createdAt: string
}

export interface PricingSettings {
  usdToEurRate: string
  marginPercent: number
  /** `environment` until an administrator saves a first value. */
  source: 'database' | 'environment'
  change: PricingChange | null
}

export interface PricingResponse {
  /** Null when nobody has set the exchange rate: usage is refused until then. */
  current: PricingSettings | null
  history: PricingChange[]
}
