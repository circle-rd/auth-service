import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import {
  applications,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import { ApiError, ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import { stripe } from "../stripe.js";
import { provisionPlanPrice, provisionPlanProduct } from "./catalog.js";
import { getOrCreateBillingCustomer } from "./customers.js";

/**
 * Keeps the Stripe subscription of a (user, application) pair in line with the
 * plan assigned in auth-service. Every plan gets a Stripe subscription, the
 * default `free` plan included (with a 0 EUR price created on demand), so a
 * metered feature on a free plan can still be billed and an upgrade is a simple
 * item swap.
 *
 * The sync runs from the assignment paths (admin grant, default plan, self
 * service), never from `setUserSubscription` itself: that function is also the
 * target of the Stripe webhooks, and calling Stripe back from it would loop.
 */

async function readSubscription(userId: string, applicationId: string) {
  const [row] = await db
    .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row;
}

/** The recurring, fixed Stripe Price of a plan, if one exists. */
async function recurringPriceId(planId: string): Promise<string | null> {
  const rows = await db
    .select({
      stripePriceId: subscriptionPlanPrices.stripePriceId,
      interval: subscriptionPlanPrices.interval,
    })
    .from(subscriptionPlanPrices)
    .where(
      and(
        eq(subscriptionPlanPrices.planId, planId),
        eq(subscriptionPlanPrices.billingType, "fixed"),
      ),
    );
  const recurring = rows.filter(
    (r) => r.stripePriceId && r.interval !== "one_time",
  );
  return (
    recurring.find((r) => r.interval === "month")?.stripePriceId ??
    recurring[0]?.stripePriceId ??
    null
  );
}

/**
 * The Price a Stripe subscription bills for a plan. A plan with no price at all
 * (the default `free` plan of a new application) gets a 0 EUR monthly Price,
 * created here and linked to the plan, so its subscription can exist.
 */
async function ensureSubscriptionPrice(planId: string): Promise<string | null> {
  const existing = await recurringPriceId(planId);
  if (existing) return existing;

  const [plan] = await db
    .select({
      id: subscriptionPlans.id,
      applicationId: subscriptionPlans.applicationId,
      stripeProductId: subscriptionPlans.stripeProductId,
      isDefault: subscriptionPlans.isDefault,
    })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);
  if (!plan) return null;

  // Only the default (free) plan gets an implicit price; a paid plan without a
  // recurring price is a configuration error, not something to invent.
  const rows = await db
    .select({ id: subscriptionPlanPrices.id })
    .from(subscriptionPlanPrices)
    .where(eq(subscriptionPlanPrices.planId, planId))
    .limit(1);
  if (!plan.isDefault || rows.length > 0) return null;

  const [app] = await db
    .select({ name: applications.name, slug: applications.slug })
    .from(applications)
    .where(eq(applications.id, plan.applicationId))
    .limit(1);
  if (!app) return null;

  const [row] = await db
    .insert(subscriptionPlanPrices)
    .values({
      planId,
      name: "Free",
      amount: "0",
      currency: "eur",
      interval: "month",
      billingType: "fixed",
    })
    .returning({ id: subscriptionPlanPrices.id });

  let stripeProductId = plan.stripeProductId;
  if (!stripeProductId) {
    stripeProductId = await provisionPlanProduct({
      applicationId: plan.applicationId,
      appName: app.name,
      planName: "Free",
      description: null,
    });
    if (stripeProductId) {
      await db
        .update(subscriptionPlans)
        .set({ stripeProductId })
        .where(eq(subscriptionPlans.id, planId));
    }
  }
  const provision = await provisionPlanPrice({
    applicationId: plan.applicationId,
    appSlug: app.slug,
    appName: app.name,
    stripeProductId,
    planId,
    name: "Free",
    amount: 0,
    currency: "eur",
    interval: "month",
    billingType: "fixed",
  });
  if (!provision.stripePriceId) return null;
  await db
    .update(subscriptionPlanPrices)
    .set({
      stripePriceId: provision.stripePriceId,
      stripeMeterId: provision.stripeMeterId,
    })
    .where(eq(subscriptionPlanPrices.id, row!.id));
  return provision.stripePriceId;
}

/**
 * Create or update the Stripe subscription of a (user, application) pair to match
 * the assigned plan. Best-effort: a Stripe failure is logged and the local
 * entitlement stays authoritative; `pnpm billing:reconcile` can catch up.
 */
export async function syncStripeSubscription(input: {
  userId: string;
  applicationId: string;
  planId: string;
}): Promise<void> {
  if (!stripe) return;
  try {
    const priceId = await ensureSubscriptionPrice(input.planId);
    if (!priceId) {
      logger.warn(
        { planId: input.planId },
        "[billing] plan has no recurring Price; no Stripe subscription created",
      );
      return;
    }
    const customer = await getOrCreateBillingCustomer("user", input.userId);
    const metadata = {
      userId: input.userId,
      applicationId: input.applicationId,
      planId: input.planId,
    };
    const existing = await readSubscription(input.userId, input.applicationId);

    if (existing?.stripeSubscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(
        existing.stripeSubscriptionId,
      );
      const item = subscription.items.data[0];
      const params: Stripe.SubscriptionUpdateParams = {
        metadata,
        cancel_at_period_end: false,
      };
      if (item && item.price.id !== priceId) {
        params.items = [{ id: item.id, price: priceId }];
      }
      await stripe.subscriptions.update(subscription.id, params);
      return;
    }

    const created = await stripe.subscriptions.create(
      {
        customer: customer.stripeCustomerId,
        items: [{ price: priceId }],
        metadata,
      },
      {
        idempotencyKey: `billing:subscription:${input.userId}:${input.applicationId}`,
      },
    );
    await db
      .update(userSubscriptions)
      .set({ stripeSubscriptionId: created.id, stripeStatus: created.status })
      .where(
        and(
          eq(userSubscriptions.userId, input.userId),
          eq(userSubscriptions.applicationId, input.applicationId),
        ),
      );
  } catch (err) {
    logger.warn(
      { err: String(err), ...input },
      "[billing] Stripe subscription sync failed; the reconciler will retry",
    );
  }
}

/** Cancel the Stripe subscription of a (user, application) pair, at period end. */
export async function cancelStripeSubscription(input: {
  userId: string;
  applicationId: string;
}): Promise<void> {
  if (!stripe) return;
  const existing = await readSubscription(input.userId, input.applicationId);
  if (!existing?.stripeSubscriptionId) return;
  try {
    await stripe.subscriptions.update(existing.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  } catch (err) {
    logger.warn(
      { err: String(err), ...input },
      "[billing] Stripe subscription cancellation failed",
    );
  }
}

/** Open a Stripe Checkout in subscription mode for a paid plan. */
export async function createSubscriptionCheckout(input: {
  userId: string;
  applicationId: string;
  planId: string;
}): Promise<{ url: string }> {
  if (!stripe) throw ERR.BIL_001();
  const [plan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.id, input.planId),
        eq(subscriptionPlans.applicationId, input.applicationId),
      ),
    )
    .limit(1);
  if (!plan) throw ERR.APP_002();
  const linked = await readLinkedSubscription(
    input.userId,
    input.applicationId,
  );
  // A paid subscription is changed in place: a second checkout would bill twice.
  if (
    linked?.isActive &&
    linked.stripeSubscriptionId &&
    (await planIsPaid(linked.planId))
  ) {
    throw ERR.SUB_007();
  }
  if (!(await planIsPaid(input.planId))) {
    throw ERR.BIL_002("A free plan needs no checkout");
  }
  const priceId = await recurringPriceId(input.planId);
  if (!priceId) throw ERR.BIL_002("This plan has no recurring price");
  const customer = await getOrCreateBillingCustomer("user", input.userId);
  const metadata = {
    purpose: "subscription",
    userId: input.userId,
    applicationId: input.applicationId,
    planId: input.planId,
  };
  const returnUrl = `${config.betterAuth.url}/profile`;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata },
    metadata,
    success_url: `${returnUrl}?subscription=success`,
    cancel_url: `${returnUrl}?subscription=cancelled`,
  });
  if (!session.url) throw ERR.SRV_001("Stripe returned no checkout URL");
  return { url: session.url };
}

/** Open the Stripe Billing Portal (payment methods, cancellation) for a user. */
export async function createBillingPortalUrl(input: {
  userId: string;
}): Promise<{ url: string }> {
  if (!stripe) throw ERR.BIL_001();
  const customer = await getOrCreateBillingCustomer("user", input.userId);
  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: `${config.betterAuth.url}/profile`,
  });
  return { url: session.url };
}

/** Whether a plan charges anything: a recurring fixed price above zero. */
export async function planIsPaid(planId: string): Promise<boolean> {
  const rows = await db
    .select({
      amount: subscriptionPlanPrices.amount,
      interval: subscriptionPlanPrices.interval,
    })
    .from(subscriptionPlanPrices)
    .where(
      and(
        eq(subscriptionPlanPrices.planId, planId),
        eq(subscriptionPlanPrices.billingType, "fixed"),
      ),
    );
  return rows.some((r) => r.interval !== "one_time" && Number(r.amount) > 0);
}

/** The Stripe linkage of a (user, application) subscription row, if any. */
export async function readLinkedSubscription(
  userId: string,
  applicationId: string,
) {
  const [row] = await db
    .select({
      stripeSubscriptionId: userSubscriptions.stripeSubscriptionId,
      planId: userSubscriptions.planId,
      isActive: userSubscriptions.isActive,
      cancelAtPeriodEnd: userSubscriptions.cancelAtPeriodEnd,
    })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Move a live Stripe subscription to another price, in place: Stripe prorates
 * it. Unlike the background sync, a failure is raised, because a user or an
 * administrator is waiting for the outcome. The local plan follows through the
 * subscription's update event, so the entitlement never runs ahead of the charge.
 */
export async function switchSubscriptionPlan(input: {
  userId: string;
  applicationId: string;
  planId: string;
}): Promise<void> {
  if (!stripe) throw ERR.BIL_001();
  const linked = await readLinkedSubscription(
    input.userId,
    input.applicationId,
  );
  if (!linked?.stripeSubscriptionId) throw ERR.SUB_008();
  const priceId = await recurringPriceId(input.planId);
  if (!priceId) throw ERR.BIL_002("This plan has no recurring price");
  try {
    const subscription = await stripe.subscriptions.retrieve(
      linked.stripeSubscriptionId,
    );
    const item = subscription.items.data[0];
    if (!item) throw ERR.BIL_004();
    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id, price: priceId }],
      metadata: {
        userId: input.userId,
        applicationId: input.applicationId,
        planId: input.planId,
      },
      cancel_at_period_end: false,
      proration_behavior: "create_prorations",
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn(
      { err: String(err), ...input },
      "[billing] plan change refused by Stripe",
    );
    throw ERR.BIL_004();
  }
}

/**
 * Stop (or resume) a Stripe subscription at the end of its period. The local
 * flag is written at once; the subscription's update event confirms it.
 */
export async function setCancelAtPeriodEnd(input: {
  userId: string;
  applicationId: string;
  cancel: boolean;
}): Promise<void> {
  if (!stripe) throw ERR.BIL_001();
  const linked = await readLinkedSubscription(
    input.userId,
    input.applicationId,
  );
  if (!linked?.stripeSubscriptionId) throw ERR.SUB_008();
  try {
    await stripe.subscriptions.update(linked.stripeSubscriptionId, {
      cancel_at_period_end: input.cancel,
    });
  } catch (err) {
    logger.warn(
      { err: String(err), ...input },
      "[billing] cancellation change refused by Stripe",
    );
    throw ERR.BIL_004();
  }
  await db
    .update(userSubscriptions)
    .set({ cancelAtPeriodEnd: input.cancel, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, input.userId),
        eq(userSubscriptions.applicationId, input.applicationId),
      ),
    );
}
