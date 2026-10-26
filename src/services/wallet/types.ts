import type { walletAccounts, walletTransactions } from "../../db/schema.js";
import type { OwnerType } from "../owners.js";

/** 1 EUR in the ledger unit (integer micro-euros). */
export const MICRO_PER_EUR = 1_000_000n;

/** Upper bound of a single operation: 1,000,000 EUR. */
export const MAX_WALLET_AMOUNT = 1_000_000n * MICRO_PER_EUR;

export const WALLET_TRANSACTION_TYPES = [
  "topup",
  "grant",
  "refund",
  "usage",
  "adjust",
  "reversal",
] as const;

/** Operations that record something already done: they may overdraw. */
export const NEGATIVE_BALANCE_TYPES: readonly string[] = ["usage", "reversal"];

export type WalletOwnerType = OwnerType;
export type WalletCreditType = "topup" | "grant" | "refund" | "adjust";
export type WalletDebitType = "usage" | "adjust" | "reversal";

export type WalletAccount = typeof walletAccounts.$inferSelect;
export type WalletTransaction = typeof walletTransactions.$inferSelect;

export type WalletMetadata = Record<string, unknown>;

interface WalletOperationInput {
  accountId: string;
  /** Strictly positive, in micro-euros. */
  amount: bigint;
  /** Replay key: the same key with the same parameters is applied once. */
  idempotencyKey: string;
  applicationId?: string;
  metadata?: WalletMetadata;
}

export interface WalletCreditInput extends WalletOperationInput {
  type: WalletCreditType;
}

export interface WalletDebitInput extends WalletOperationInput {
  type: WalletDebitType;
}

export interface WalletOperationResult {
  transaction: WalletTransaction;
  /** True when the key had already been applied and nothing changed. */
  replayed: boolean;
}

/** API representation: amounts are strings because JSON has no bigint. */
export interface WalletAccountView {
  /** Micro-euros; negative when usage or a refund exceeded the credit. */
  balance: string;
  isUnlimited: boolean;
  /** Whether new spending is allowed: unlimited, or a strictly positive balance. */
  canSpend: boolean;
  currency: "eur";
}

export interface WalletTransactionView {
  id: string;
  type: WalletTransaction["type"];
  amount: string;
  delta: string;
  balanceAfter: string;
  applicationId: string | null;
  metadata: WalletMetadata;
  createdAt: string;
}

export interface WalletTransactionPage {
  items: WalletTransactionView[];
  nextCursor: string | null;
}

// ── Statistics ────────────────────────────────────────────────────────────────

/** One day of a spend or top-up series; amounts are micro-euro strings. */
export interface WalletDailyPoint {
  date: string;
  amount: string;
  count: number;
}

export interface WalletBreakdownEntry {
  /** Application id, or null when the usage predates a deleted application. */
  applicationId: string | null;
  name: string | null;
  slug: string | null;
  amount: string;
  count: number;
}

export interface WalletKindEntry {
  kind: string;
  amount: string;
  count: number;
}

export interface UserSpendStats {
  days: number;
  total: string;
  /** Part of `total` that was never deducted (usage on an unlimited account). */
  notBilled: string;
  calls: number;
  series: WalletDailyPoint[];
  byApplication: WalletBreakdownEntry[];
  byKind: WalletKindEntry[];
}

export interface WalletTopConsumer {
  ownerType: string;
  ownerId: string;
  name: string | null;
  email: string | null;
  amount: string;
  count: number;
}

export interface AdminWalletStats {
  days: number;
  totals: {
    accounts: number;
    accountsInDebt: number;
    unlimitedAccounts: number;
    /** Credit owed to users: sum of positive balances, unlimited accounts excluded. */
    outstandingCredit: string;
    /** Debt owed by users: sum of negative balances, as a positive number. */
    outstandingDebt: string;
  };
  spend: {
    total: string;
    /** Part of `total` that was never deducted (usage on unlimited accounts). */
    notBilled: string;
    calls: number;
    series: WalletDailyPoint[];
  };
  topUps: { total: string; count: number; series: WalletDailyPoint[] };
  topConsumers: WalletTopConsumer[];
  byApplication: WalletBreakdownEntry[];
  byKind: WalletKindEntry[];
}

export type WalletListFilter = "all" | "debt" | "credit" | "unlimited";

export interface WalletListItem {
  id: string;
  ownerType: string;
  ownerId: string;
  name: string | null;
  email: string | null;
  balance: string;
  isUnlimited: boolean;
  canSpend: boolean;
  spent30d: string;
  updatedAt: string;
}

/** One gateway usage debit, as exposed for reconciliation. */
export interface GatewayUsageEntry {
  /** The gateway's call id, kept in the ledger metadata. */
  requestId: string | null;
  userId: string;
  /** Micro-euros charged. */
  amount: string;
  /** Provider cost reported by the gateway, as recorded in the ledger. */
  costUsd: string | null;
  createdAt: string;
}

export interface GatewayUsagePage {
  items: GatewayUsageEntry[];
  nextCursor: string | null;
}

/** Settings that turn a provider cost in US dollars into micro-euros. */
export interface UsdPricing {
  /** Decimal string, euros per US dollar. */
  usdToEurRate: string;
  /** Percentage added on top of the provider cost. */
  marginPercent: number;
}

export interface PricingChange extends UsdPricing {
  id: string;
  reason: string;
  actor: { id: string; name: string | null };
  createdAt: Date;
}

export interface PricingSettings extends UsdPricing {
  /** `environment` until an administrator saves a first value. */
  source: "database" | "environment";
  /** The change that produced these settings; null when they come from the environment. */
  change: PricingChange | null;
}

export interface PricingChangeView extends UsdPricing {
  id: string;
  reason: string;
  actor: { id: string; name: string | null };
  createdAt: string;
}

export interface PricingSettingsView extends UsdPricing {
  source: PricingSettings["source"];
  change: PricingChangeView | null;
}
