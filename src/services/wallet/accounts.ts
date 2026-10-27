import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { walletAccounts } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { assertOwnerExists } from "../owners.js";
import type { WalletAccount, WalletOwnerType } from "./types.js";

const accountColumns = {
  id: walletAccounts.id,
  ownerType: walletAccounts.ownerType,
  ownerId: walletAccounts.ownerId,
  balance: walletAccounts.balance,
  isUnlimited: walletAccounts.isUnlimited,
  createdAt: walletAccounts.createdAt,
  updatedAt: walletAccounts.updatedAt,
};

export async function findWalletAccount(
  ownerType: WalletOwnerType,
  ownerId: string,
): Promise<WalletAccount | undefined> {
  const [account] = await db
    .select(accountColumns)
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.ownerType, ownerType),
        eq(walletAccounts.ownerId, ownerId),
      ),
    )
    .limit(1);
  return account;
}

/** Return the owner's wallet, creating an empty one on first use. */
export async function getOrCreateWalletAccount(
  ownerType: WalletOwnerType,
  ownerId: string,
): Promise<WalletAccount> {
  const existing = await findWalletAccount(ownerType, ownerId);
  if (existing) return existing;

  await assertOwnerExists(ownerType, ownerId);
  await db
    .insert(walletAccounts)
    .values({ ownerType, ownerId })
    .onConflictDoNothing();

  const account = await findWalletAccount(ownerType, ownerId);
  if (!account) throw ERR.WAL_001();
  return account;
}
