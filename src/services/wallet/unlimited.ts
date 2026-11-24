import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { walletAccountEvents, walletAccounts } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { notifyWalletChanged, type WalletOwner } from "./events.js";
import type { WalletAccount } from "./types.js";

export interface SetUnlimitedInput {
  accountId: string;
  isUnlimited: boolean;
  actorId: string;
  reason: string;
}

/**
 * Toggle unlimited access. A change is audited in `wallet_account_events` in
 * the same transaction; setting the current value again is a no-op and leaves
 * no event, so the trail only contains real changes.
 */
export async function setWalletUnlimited(
  input: SetUnlimitedInput,
): Promise<WalletAccount> {
  let changed = false;
  let owner = null as WalletOwner | null;
  const account = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.id, input.accountId))
      .for("update")
      .limit(1);
    if (!account) throw ERR.WAL_001();
    if (account.isUnlimited === input.isUnlimited) return account;

    const [updated] = await tx
      .update(walletAccounts)
      .set({ isUnlimited: input.isUnlimited, updatedAt: new Date() })
      .where(eq(walletAccounts.id, input.accountId))
      .returning();
    if (!updated) throw ERR.WAL_001();
    owner = { ownerType: updated.ownerType, ownerId: updated.ownerId };

    await tx.insert(walletAccountEvents).values({
      accountId: input.accountId,
      actorUserId: input.actorId,
      action: input.isUnlimited ? "unlimited_enabled" : "unlimited_disabled",
      details: { reason: input.reason },
    });
    changed = true;
    return updated;
  });
  if (changed && owner) notifyWalletChanged(owner);
  return account;
}
