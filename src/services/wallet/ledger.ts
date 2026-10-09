import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { walletAccounts, walletTransactions } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import {
  MAX_WALLET_AMOUNT,
  type WalletCreditInput,
  type WalletDebitInput,
  type WalletOperationResult,
  type WalletTransaction,
} from "./types.js";

interface SignedOperation {
  accountId: string;
  type: WalletTransaction["type"];
  /** Signed value: positive credits, negative debits. */
  amount: bigint;
  idempotencyKey: string;
  applicationId?: string;
  metadata?: Record<string, unknown>;
}

function assertValidAmount(amount: bigint): void {
  if (
    typeof amount !== "bigint" ||
    amount <= 0n ||
    amount > MAX_WALLET_AMOUNT
  ) {
    throw ERR.WAL_004(
      "Amount must be a positive integer number of micro-euros",
      {
        max: MAX_WALLET_AMOUNT.toString(),
      },
    );
  }
}

function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > 255) {
    throw ERR.WAL_004("Idempotency key must be 1 to 255 characters");
  }
}

function assertSameOperation(
  existing: WalletTransaction,
  op: SignedOperation,
): void {
  if (
    existing.type !== op.type ||
    existing.amount !== op.amount ||
    existing.applicationId !== (op.applicationId ?? null)
  ) {
    throw ERR.WAL_003();
  }
}

/**
 * Apply one ledger operation atomically. The account row is locked for the
 * duration of the transaction, so concurrent operations on a wallet are
 * serialised: the overdraft check, the balance update and the ledger insert
 * cannot interleave, and a retried idempotency key always finds the first
 * attempt. A rejected operation leaves no trace.
 */
async function applyOperation(
  op: SignedOperation,
): Promise<WalletOperationResult> {
  assertValidKey(op.idempotencyKey);

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: walletAccounts.id,
        balance: walletAccounts.balance,
        isUnlimited: walletAccounts.isUnlimited,
      })
      .from(walletAccounts)
      .where(eq(walletAccounts.id, op.accountId))
      .for("update")
      .limit(1);
    if (!account) throw ERR.WAL_001();

    const [existing] = await tx
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.accountId, op.accountId),
          eq(walletTransactions.idempotencyKey, op.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      assertSameOperation(existing, op);
      return { transaction: existing, replayed: true };
    }

    // Unlimited accounts keep their balance: usage is recorded, not deducted.
    const delta = account.isUnlimited && op.type === "usage" ? 0n : op.amount;
    const balanceAfter = account.balance + delta;
    if (balanceAfter < 0n) {
      throw ERR.WAL_002("Insufficient credit balance", {
        balance: account.balance.toString(),
        required: (-op.amount).toString(),
      });
    }

    await tx
      .update(walletAccounts)
      .set({ balance: balanceAfter, updatedAt: new Date() })
      .where(eq(walletAccounts.id, op.accountId));

    const [transaction] = await tx
      .insert(walletTransactions)
      .values({
        accountId: op.accountId,
        type: op.type,
        amount: op.amount,
        delta,
        balanceAfter,
        idempotencyKey: op.idempotencyKey,
        applicationId: op.applicationId ?? null,
        metadata: op.metadata ?? {},
      })
      .returning();
    if (!transaction) throw ERR.WAL_001();
    return { transaction, replayed: false };
  });
}

export async function creditWallet(
  input: WalletCreditInput,
): Promise<WalletOperationResult> {
  assertValidAmount(input.amount);
  return applyOperation({ ...input });
}

export async function debitWallet(
  input: WalletDebitInput,
): Promise<WalletOperationResult> {
  assertValidAmount(input.amount);
  return applyOperation({ ...input, amount: -input.amount });
}
