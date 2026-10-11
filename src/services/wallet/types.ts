import type { walletAccounts, walletTransactions } from "../../db/schema.js";

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

export type WalletOwnerType = "user" | "org";
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
