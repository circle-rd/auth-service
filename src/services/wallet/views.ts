import type {
  PricingChange,
  PricingChangeView,
  PricingSettings,
  PricingSettingsView,
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
    canSpend: account.isUnlimited || account.balance > 0n,
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

export function toPricingChangeView(change: PricingChange): PricingChangeView {
  return {
    id: change.id,
    usdToEurRate: change.usdToEurRate,
    marginPercent: change.marginPercent,
    reason: change.reason,
    actor: change.actor,
    createdAt: change.createdAt.toISOString(),
  };
}

export function toPricingSettingsView(
  settings: PricingSettings,
): PricingSettingsView {
  return {
    usdToEurRate: settings.usdToEurRate,
    marginPercent: settings.marginPercent,
    source: settings.source,
    change: settings.change ? toPricingChangeView(settings.change) : null,
  };
}
