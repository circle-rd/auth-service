import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  applications,
  billingCustomers,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { isStripeConfigured } from "../services/stripe.js";
import { getOrCreateBillingCustomer } from "../services/billing/customers.js";
import {
  provisionPlanPrice,
  provisionPlanProduct,
} from "../services/billing/catalog.js";
import { syncStripeSubscription } from "../services/billing/subscriptions.js";

/**
 * Idempotent reconciliation of the Stripe objects the database expects: a
 * Customer for every user, a Product for every plan, a Price (and its Meter) for
 * every price row. It only creates what is missing — it never archives or
 * deletes anything, so it is safe to run against any environment with Stripe
 * configured. Run it after an outage, a restore, or an upgrade.
 *
 *   pnpm billing:reconcile
 */
async function main(): Promise<void> {
  if (!isStripeConfigured()) {
    process.stdout.write("Stripe is not configured; nothing to reconcile.\n");
    return;
  }

  const users = await db.select({ id: userTable.id }).from(userTable);
  const withCustomer = new Set(
    (
      await db
        .select({ ownerId: billingCustomers.ownerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.ownerType, "user"))
    ).map((r) => r.ownerId),
  );
  let customers = 0;
  for (const user of users) {
    if (withCustomer.has(user.id)) continue;
    await getOrCreateBillingCustomer("user", user.id);
    customers += 1;
  }

  const plans = await db
    .select({
      id: subscriptionPlans.id,
      applicationId: subscriptionPlans.applicationId,
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
      stripeProductId: subscriptionPlans.stripeProductId,
      appName: applications.name,
      appSlug: applications.slug,
    })
    .from(subscriptionPlans)
    .innerJoin(
      applications,
      eq(applications.id, subscriptionPlans.applicationId),
    );

  let products = 0;
  let prices = 0;
  for (const plan of plans) {
    let stripeProductId = plan.stripeProductId;
    if (!stripeProductId) {
      stripeProductId = await provisionPlanProduct({
        applicationId: plan.applicationId,
        appName: plan.appName,
        planName: plan.name,
        description: plan.description,
      });
      if (stripeProductId) {
        await db
          .update(subscriptionPlans)
          .set({ stripeProductId })
          .where(eq(subscriptionPlans.id, plan.id));
        products += 1;
      }
    }

    const rows = await db
      .select({
        id: subscriptionPlanPrices.id,
        name: subscriptionPlanPrices.name,
        amount: subscriptionPlanPrices.amount,
        currency: subscriptionPlanPrices.currency,
        interval: subscriptionPlanPrices.interval,
        billingType: subscriptionPlanPrices.billingType,
        featureKey: subscriptionPlanPrices.featureKey,
        stripePriceId: subscriptionPlanPrices.stripePriceId,
      })
      .from(subscriptionPlanPrices)
      .where(eq(subscriptionPlanPrices.planId, plan.id));

    for (const price of rows) {
      if (price.stripePriceId) continue;
      const provision = await provisionPlanPrice({
        applicationId: plan.applicationId,
        appSlug: plan.appSlug,
        appName: plan.appName,
        stripeProductId,
        planId: plan.id,
        name: price.name,
        amount: Number(price.amount),
        currency: price.currency,
        interval: price.interval,
        billingType: price.billingType as "fixed" | "metered",
        featureKey: price.featureKey,
      });
      if (!provision.stripePriceId) continue;
      await db
        .update(subscriptionPlanPrices)
        .set({
          stripePriceId: provision.stripePriceId,
          stripeMeterId: provision.stripeMeterId,
        })
        .where(eq(subscriptionPlanPrices.id, price.id));
      prices += 1;
    }
  }

  // Every assigned plan is backed by a Stripe subscription; create the missing
  // ones (the local row already exists, sync links it).
  const unlinked = await db
    .select({
      userId: userSubscriptions.userId,
      applicationId: userSubscriptions.applicationId,
      planId: userSubscriptions.planId,
    })
    .from(userSubscriptions)
    .where(isNull(userSubscriptions.stripeSubscriptionId));
  for (const row of unlinked) {
    await syncStripeSubscription(row);
  }

  process.stdout.write(
    `✓ reconciled: ${customers} customer(s), ${products} product(s), ${prices} price(s) created, ${unlinked.length} subscription(s) linked\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
