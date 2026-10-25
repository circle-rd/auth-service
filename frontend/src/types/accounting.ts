export const JOURNAL_KINDS = [
  'topup',
  'grant',
  'refund',
  'adjust',
  'reversal',
  'unlimited_enabled',
  'unlimited_disabled',
  'subscription_assigned',
  'subscription_changed',
  'subscription_removed',
] as const

export type JournalKind = (typeof JOURNAL_KINDS)[number]

export interface JournalPerson {
  id: string
  name: string | null
  email: string | null
}

export interface JournalOwner extends JournalPerson {
  type: 'user' | 'org'
}

export interface JournalEntry {
  id: string
  kind: JournalKind
  createdAt: string
  /** Wallet owner or subscriber. */
  owner: JournalOwner
  /** Administrator who acted; null for automatic paths (Stripe, default plan). */
  actor: JournalPerson | null
  source: 'manual' | 'stripe' | 'admin' | 'self' | 'default' | null
  application: { id: string; name: string; slug: string } | null
  /** Signed micro-euros. */
  amount: string | null
  balanceAfter: string | null
  fromPlan: string | null
  toPlan: string | null
  reason: string | null
  reference: string | null
}

export interface JournalPage {
  entries: JournalEntry[]
  total: number
  page: number
  limit: number
}

export interface JournalQuery {
  page: number
  limit: number
  kind?: JournalKind
  userId?: string
  applicationId?: string
  /** ISO instant, inclusive. */
  from?: string
  /** ISO instant, exclusive. */
  to?: string
}
