import { creditWallet, debitWallet } from "./ledger.js";
import type { WalletOperationResult } from "./types.js";

interface AdminOperationInput {
  accountId: string;
  idempotencyKey: string;
  actorId: string;
  reason: string;
}

/** Credit given by an administrator (promotion, compensation, support). */
export async function grantCredit(
  input: AdminOperationInput & { amount: bigint },
): Promise<WalletOperationResult> {
  return creditWallet({
    accountId: input.accountId,
    type: "grant",
    amount: input.amount,
    idempotencyKey: input.idempotencyKey,
    metadata: { actorId: input.actorId, reason: input.reason },
  });
}

/** Signed manual correction: positive adds credit, negative removes it. */
export async function adjustBalance(
  input: AdminOperationInput & { amount: bigint },
): Promise<WalletOperationResult> {
  const operation = {
    accountId: input.accountId,
    type: "adjust" as const,
    idempotencyKey: input.idempotencyKey,
    metadata: { actorId: input.actorId, reason: input.reason },
  };
  return input.amount > 0n
    ? creditWallet({ ...operation, amount: input.amount })
    : debitWallet({ ...operation, amount: -input.amount });
}
