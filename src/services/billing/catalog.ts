import type Stripe from "stripe";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { subscriptionPlanPrices, subscriptionPlans } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import { stripe } from "../stripe.js";

/**
 * Keeps the Stripe catalogue (Products, Prices, Meters) in sync with the plan
 * rows. The operator never opens the Stripe dashboard: every object is created,
 * updated or archived from here. When Stripe is not configured every function
 * is a no-op and returns no ids, so the plan rows still exist and a later
 * reconciliation can fill the missing links.
 */

/** Stripe caps `meter` event names; keep our derived name inside the limit. */
const METER_EVENT_NAME_MAX = 100;

/** The event name an application reports metered usage under (Lot 4). */
export function meterEventName(appSlug: string, featureKey: string): string {
  return `app_${appSlug}__${featureKey}`;
}

function assertMeterEventNameFits(eventName: string): void {
  if (eventName.length > METER_EVENT_NAME_MAX) {
    throw ERR.BIL_002(
      `Meter event name is ${eventName.length} characters; the limit is ${METER_EVENT_NAME_MAX}`,
    );
  }
}

export function productName(appName: string, planName: string): string {
  return `${appName} — ${planName}`;
}

// ── Products ────────────────────────────────────────────────────────────────

/** Create the Stripe Product of a plan. Returns its id, or null without Stripe. */
export async function provisionPlanProduct(input: {
  applicationId: string;
  appName: string;
  planName: string;
  description: string | null;
}): Promise<string | null> {
  if (!stripe) return null;
  const product = await stripe.products.create({
    name: productName(input.appName, input.planName),
    ...(input.description ? { description: input.description } : {}),
    metadata: { applicationId: input.applicationId },
  });
  return product.id;
}

/** Rename / re-describe an existing Product so it matches the plan row. */
export async function updatePlanProduct(input: {
  stripeProductId: string;
  applicationId: string;
  appName: string;
  planName: string;
  description: string | null;
}): Promise<void> {
  if (!stripe) return;
  await stripe.products.update(input.stripeProductId, {
    name: productName(input.appName, input.planName),
    description: input.description ?? "",
    metadata: { applicationId: input.applicationId },
  });
}

/** Archive (never delete) a plan's Product. */
export async function archivePlanProduct(
  stripeProductId: string | null,
): Promise<void> {
  if (!stripe || !stripeProductId) return;
  await stripe.products.update(stripeProductId, { active: false });
}

/**
 * Create the Product of a plan created outside the plan route (an application's
 * default plan) and link it. Best-effort: a Stripe outage must not fail the
 * application creation; reconciliation fills the missing link later.
 */
export async function provisionPlanProductBestEffort(input: {
  planId: string;
  applicationId: string;
  appName: string;
  planName: string;
  description: string | null;
}): Promise<void> {
  if (!stripe) return;
  try {
    const stripeProductId = await provisionPlanProduct(input);
    if (!stripeProductId) return;
    await db
      .update(subscriptionPlans)
      .set({ stripeProductId })
      .where(eq(subscriptionPlans.id, input.planId));
  } catch (err) {
    logger.warn(
      { err: String(err), planId: input.planId },
      "[billing] plan product provisioning failed; the reconciler will retry",
    );
  }
}

/** Rename the plans' Products after the application was renamed. Best-effort. */
export async function updateApplicationProducts(input: {
  applicationId: string;
  appName: string;
}): Promise<void> {
  if (!stripe) return;
  const plans = await db
    .select({
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
      stripeProductId: subscriptionPlans.stripeProductId,
    })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, input.applicationId));
  for (const plan of plans) {
    if (!plan.stripeProductId) continue;
    try {
      await updatePlanProduct({
        stripeProductId: plan.stripeProductId,
        applicationId: input.applicationId,
        appName: input.appName,
        planName: plan.name,
        description: plan.description,
      });
    } catch (err) {
      logger.warn(
        { err: String(err), stripeProductId: plan.stripeProductId },
        "[billing] plan product rename failed; the reconciler will retry",
      );
    }
  }
}

export interface CataloguePlan {
  stripeProductId: string | null;
  prices: Array<{
    stripePriceId: string | null;
    stripeMeterId: string | null;
  }>;
}

/** The Stripe objects of an application's plans, read before its rows cascade away. */
export async function loadApplicationCatalogue(
  applicationId: string,
): Promise<CataloguePlan[]> {
  const rows = await db
    .select({
      planId: subscriptionPlans.id,
      stripeProductId: subscriptionPlans.stripeProductId,
      stripePriceId: subscriptionPlanPrices.stripePriceId,
      stripeMeterId: subscriptionPlanPrices.stripeMeterId,
    })
    .from(subscriptionPlans)
    .leftJoin(
      subscriptionPlanPrices,
      eq(subscriptionPlanPrices.planId, subscriptionPlans.id),
    )
    .where(eq(subscriptionPlans.applicationId, applicationId));

  const byPlan = new Map<string, CataloguePlan>();
  for (const row of rows) {
    const plan = byPlan.get(row.planId) ?? {
      stripeProductId: row.stripeProductId,
      prices: [],
    };
    if (row.stripePriceId || row.stripeMeterId) {
      plan.prices.push({
        stripePriceId: row.stripePriceId,
        stripeMeterId: row.stripeMeterId,
      });
    }
    byPlan.set(row.planId, plan);
  }
  return [...byPlan.values()];
}

/**
 * Archive a deleted application's catalogue: its Prices, its Products, and
 * deactivate every Meter it owned. Best-effort per object, so one failure does
 * not leave the rest unarchived.
 */
export async function archiveApplicationCatalogue(
  plans: CataloguePlan[],
): Promise<void> {
  if (!stripe) return;
  const meters = new Set<string>();
  for (const plan of plans) {
    for (const price of plan.prices) {
      if (price.stripeMeterId) meters.add(price.stripeMeterId);
      try {
        await archivePlanPrice(price.stripePriceId);
      } catch (err) {
        logger.warn(
          { err: String(err), stripePriceId: price.stripePriceId },
          "[billing] price archive failed",
        );
      }
    }
    try {
      await archivePlanProduct(plan.stripeProductId);
    } catch (err) {
      logger.warn(
        { err: String(err), stripeProductId: plan.stripeProductId },
        "[billing] product archive failed",
      );
    }
  }
  for (const meterId of meters) {
    try {
      await stripe.billing.meters.deactivate(meterId);
    } catch (err) {
      logger.warn(
        { err: String(err), meterId },
        "[billing] meter deactivate failed",
      );
    }
  }
}

// ── Meters ──────────────────────────────────────────────────────────────────

/**
 * Return the meter for a (application, feature) pair, creating it on first
 * use. A meter is shared by every plan of the application that prices the same
 * feature, so usage aggregates once per customer regardless of the plan.
 */
async function getOrCreateMeter(input: {
  applicationId: string;
  appSlug: string;
  appName: string;
  featureKey: string;
}): Promise<string> {
  const [existing] = await db
    .select({ meterId: subscriptionPlanPrices.stripeMeterId })
    .from(subscriptionPlanPrices)
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlanPrices.planId, subscriptionPlans.id),
    )
    .where(
      and(
        eq(subscriptionPlans.applicationId, input.applicationId),
        eq(subscriptionPlanPrices.featureKey, input.featureKey),
        isNotNull(subscriptionPlanPrices.stripeMeterId),
      ),
    )
    .limit(1);
  if (existing?.meterId) {
    // A meter can have been deactivated when its last price was removed; it
    // must not be reused, or the new price would bill nothing.
    const current = await stripe!.billing.meters.retrieve(existing.meterId);
    if (current.status === "active") return existing.meterId;
  }

  const meter = await stripe!.billing.meters.create({
    display_name: `${input.appName} — ${input.featureKey}`,
    event_name: meterEventName(input.appSlug, input.featureKey),
    default_aggregation: { formula: "sum" },
    customer_mapping: {
      event_payload_key: "stripe_customer_id",
      type: "by_id",
    },
    value_settings: { event_payload_key: "value" },
  });
  return meter.id;
}

// ── Prices ──────────────────────────────────────────────────────────────────

export interface PlanPriceProvisionInput {
  applicationId: string;
  appSlug: string;
  appName: string;
  stripeProductId: string | null;
  planId: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  billingType: "fixed" | "metered";
  featureKey?: string | null;
}

export interface PlanPriceProvision {
  stripePriceId: string | null;
  stripeMeterId: string | null;
}

/**
 * Create the Stripe Price of a plan price row; a metered row also gets (or
 * reuses) a meter. Returns null ids when Stripe or the plan Product is missing.
 */
export async function provisionPlanPrice(
  input: PlanPriceProvisionInput,
): Promise<PlanPriceProvision> {
  if (!stripe || !input.stripeProductId) {
    return { stripePriceId: null, stripeMeterId: null };
  }

  let stripeMeterId: string | null = null;
  let recurring: Stripe.PriceCreateParams.Recurring | undefined;

  if (input.billingType === "metered") {
    const featureKey = input.featureKey!;
    assertMeterEventNameFits(meterEventName(input.appSlug, featureKey));
    stripeMeterId = await getOrCreateMeter({
      applicationId: input.applicationId,
      appSlug: input.appSlug,
      appName: input.appName,
      featureKey,
    });
    recurring = {
      interval: input.interval as "month" | "year",
      usage_type: "metered",
      meter: stripeMeterId,
    };
  } else if (input.interval !== "one_time") {
    recurring = { interval: input.interval as "month" | "year" };
  }

  const price = await stripe.prices.create({
    product: input.stripeProductId,
    unit_amount: input.amount,
    currency: input.currency,
    nickname: input.name,
    ...(recurring ? { recurring } : {}),
    metadata: { planId: input.planId },
  });
  return { stripePriceId: price.id, stripeMeterId };
}

/** Archive (never delete) a plan price. */
export async function archivePlanPrice(
  stripePriceId: string | null,
): Promise<void> {
  if (!stripe || !stripePriceId) return;
  await stripe.prices.update(stripePriceId, { active: false });
}

/** Rename an existing Price so its nickname matches the plan price row. */
export async function updatePlanPriceNickname(
  stripePriceId: string | null,
  name: string,
): Promise<void> {
  if (!stripe || !stripePriceId) return;
  await stripe.prices.update(stripePriceId, { nickname: name });
}

/**
 * Deactivate a meter once no other price of the same application still bills
 * that feature. Called after a metered price row is removed so a stale meter
 * stops accepting events.
 */
export async function deactivateMeterIfUnused(input: {
  applicationId: string;
  featureKey: string;
  stripeMeterId: string;
}): Promise<void> {
  if (!stripe) return;
  const [stillUsed] = await db
    .select({ id: subscriptionPlanPrices.id })
    .from(subscriptionPlanPrices)
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlanPrices.planId, subscriptionPlans.id),
    )
    .where(
      and(
        eq(subscriptionPlans.applicationId, input.applicationId),
        eq(subscriptionPlanPrices.featureKey, input.featureKey),
        eq(subscriptionPlanPrices.stripeMeterId, input.stripeMeterId),
      ),
    )
    .limit(1);
  if (stillUsed) return;
  await stripe.billing.meters.deactivate(input.stripeMeterId);
}
