import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { billingCustomers } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import { assertOwnerExists, type OwnerType } from "../owners.js";
import { stripe } from "../stripe.js";
import type { BillingCustomer } from "./types.js";

const columns = {
  id: billingCustomers.id,
  ownerType: billingCustomers.ownerType,
  ownerId: billingCustomers.ownerId,
  stripeCustomerId: billingCustomers.stripeCustomerId,
  createdAt: billingCustomers.createdAt,
  updatedAt: billingCustomers.updatedAt,
};

export async function findBillingCustomer(
  ownerType: OwnerType,
  ownerId: string,
): Promise<BillingCustomer | undefined> {
  const [row] = await db
    .select(columns)
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.ownerType, ownerType),
        eq(billingCustomers.ownerId, ownerId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Return the owner's Stripe Customer, creating it on first use. Stripe needs a
 * Customer before a subscription or a saved payment method can exist, and
 * creating it lazily keeps the common (free-plan) path free of Stripe calls.
 *
 * Two concurrent first-time calls are harmless: the idempotency key makes
 * Stripe return the same Customer to both, and the unique index on the owner
 * keeps a single local row.
 */
export async function getOrCreateBillingCustomer(
  ownerType: OwnerType,
  ownerId: string,
): Promise<BillingCustomer> {
  if (!stripe) throw ERR.BIL_001();

  const existing = await findBillingCustomer(ownerType, ownerId);
  if (existing) return existing;

  await assertOwnerExists(ownerType, ownerId);

  const customer = await stripe.customers.create(
    { metadata: { ownerType, ownerId } },
    { idempotencyKey: `billing:customer:${ownerType}:${ownerId}` },
  );

  await db
    .insert(billingCustomers)
    .values({ ownerType, ownerId, stripeCustomerId: customer.id })
    .onConflictDoNothing();

  const created = await findBillingCustomer(ownerType, ownerId);
  if (!created) throw ERR.SRV_003();
  return created;
}

/**
 * Create the owner's Stripe Customer without ever failing the caller: user
 * creation and access grants must not break when Stripe is down or not
 * configured. The reconciliation pass creates what was missed.
 */
export async function ensureBillingCustomerBestEffort(
  ownerType: OwnerType,
  ownerId: string,
): Promise<void> {
  if (!stripe) return;
  try {
    await getOrCreateBillingCustomer(ownerType, ownerId);
  } catch (err) {
    logger.warn(
      { err: String(err), ownerType, ownerId },
      "[billing] customer creation failed; the reconciler will retry",
    );
  }
}
