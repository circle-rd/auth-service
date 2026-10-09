import type { walletAccounts, walletTransactions } from "../../db/schema.js";

/** 1 EUR in the ledger unit (integer micro-euros). */
export const MICRO_PER_EUR = 1_000_000n;

/** Upper bound of a single operation: 1,000,000 EUR. */
export const MAX_WALLET_AMOUNT = 1_000_000n * MICRO_PER_EUR;

export type WalletOwnerType = "user" | "org";
export type WalletCreditType = "topup" | "grant" | "refund" | "adjust";
export type WalletDebitType = "usage" | "adjust";

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
