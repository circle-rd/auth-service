import type {
  WalletAccount,
  WalletMetadata,
  WalletTransaction,
  WalletAccountView,
  WalletTransactionView,
} from "./types.js";

export function toAccountView(
  account: Pick<WalletAccount, "balance" | "isUnlimited">,
): WalletAccountView {
  return {
    balance: account.balance.toString(),
    isUnlimited: account.isUnlimited,
    currency: "eur",
  };
}

export function toTransactionView(
  tx: Omit<WalletTransaction, "accountId" | "idempotencyKey">,
): WalletTransactionView {
  return {
    id: tx.id,
    type: tx.type,
    amount: tx.amount.toString(),
    delta: tx.delta.toString(),
    balanceAfter: tx.balanceAfter.toString(),
    applicationId: tx.applicationId,
    metadata: tx.metadata as WalletMetadata,
    createdAt: tx.createdAt.toISOString(),
  };
}
