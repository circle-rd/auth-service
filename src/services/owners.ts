import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { organization, user } from "../db/auth-schema.js";
import { ERR } from "../errors.js";

/** Polymorphic owner of a wallet or a billing customer: user now, org later. */
export type OwnerType = "user" | "org";

/**
 * Fail fast when the owner row does not exist. `wallet_accounts` and
 * `billing_customers` point at a user or an organization without an FK (the
 * column is polymorphic), so existence has to be checked explicitly before a
 * row is created for the owner.
 */
export async function assertOwnerExists(
  ownerType: OwnerType,
  ownerId: string,
): Promise<void> {
  if (ownerType === "user") {
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ownerId))
      .limit(1);
    if (!row) throw ERR.USR_001();
    return;
  }
  const [row] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, ownerId))
    .limit(1);
  if (!row) throw ERR.ORG_001();
}
