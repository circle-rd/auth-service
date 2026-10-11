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

export interface UserSpendStats {
  days: number
  total: string
  calls: number
  series: WalletDailyPoint[]
  byApplication: WalletBreakdownEntry[]
  byKind: WalletKindEntry[]
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
  spend: { total: string; calls: number; series: WalletDailyPoint[] }
  topUps: { total: string; count: number; series: WalletDailyPoint[] }
  topConsumers: WalletTopConsumer[]
  byApplication: WalletBreakdownEntry[]
  byKind: WalletKindEntry[]
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
