import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { billingCustomers } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import type { OwnerType } from "../owners.js";
import { stripe } from "../stripe.js";
import {
  customerCreateParams,
  customerUpdateParams,
  loadCustomerProfile,
  type CustomerProfile,
} from "./customer-profile.js";
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

async function createBillingCustomer(
  ownerType: OwnerType,
  ownerId: string,
  profile: CustomerProfile,
): Promise<BillingCustomer> {
  if (!stripe) throw ERR.BIL_001();

  const customer = await stripe.customers.create(
    customerCreateParams(profile),
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
 * Return the owner's Stripe Customer, creating it on first use with every
 * profile field auth-service knows. Stripe needs a Customer before a
 * subscription or a saved payment method can exist, and creating it lazily
 * keeps the common (free-plan) path free of Stripe calls.
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

  const profile = await loadCustomerProfile(ownerType, ownerId);
  return createBillingCustomer(ownerType, ownerId, profile);
}

/**
 * Push the current local profile (name, e-mail, phone, address, company,
 * position, …) onto the owner's Stripe Customer, creating it when missing.
 * Unlike `getOrCreateBillingCustomer`, this is the write path used after a
 * profile change; callers that must not fail on a Stripe outage use the
 * best-effort variant below.
 */
export async function updateBillingCustomer(
  stripeCustomerId: string,
  profile: CustomerProfile,
): Promise<void> {
  if (!stripe) throw ERR.BIL_001();
  await stripe.customers.update(
    stripeCustomerId,
    customerUpdateParams(profile),
  );
}

export async function syncBillingCustomer(
  ownerType: OwnerType,
  ownerId: string,
): Promise<BillingCustomer> {
  if (!stripe) throw ERR.BIL_001();

  const existing = await findBillingCustomer(ownerType, ownerId);
  if (!existing) return getOrCreateBillingCustomer(ownerType, ownerId);

  const profile = await loadCustomerProfile(ownerType, ownerId);
  await updateBillingCustomer(existing.stripeCustomerId, profile);
  return existing;
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

/**
 * Push a profile change to Stripe without failing the caller. A local profile
 * edit always succeeds; the next reconcile refreshes Stripe if this call failed.
 */
export async function syncBillingCustomerBestEffort(
  ownerType: OwnerType,
  ownerId: string,
): Promise<void> {
  if (!stripe) return;
  try {
    await syncBillingCustomer(ownerType, ownerId);
  } catch (err) {
    logger.warn(
      { err: String(err), ownerType, ownerId },
      "[billing] customer sync failed; the reconciler will retry",
    );
  }
}

/** The owner's Stripe Customer id, creating it when necessary; null on failure. */
export async function billingCustomerIdBestEffort(
  ownerType: OwnerType,
  ownerId: string,
): Promise<string | null> {
  if (!stripe) return null;
  try {
    return (await getOrCreateBillingCustomer(ownerType, ownerId))
      .stripeCustomerId;
  } catch (err) {
    logger.warn(
      { err: String(err), ownerType, ownerId },
      "[billing] customer lookup failed; falling back to the guest checkout",
    );
    return null;
  }
}
