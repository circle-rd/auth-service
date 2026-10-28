import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  billingUsageEvents,
  billingUsagePeriods,
  subscriptionPlanPrices,
  userSubscriptions,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import { stripe } from "../stripe.js";
import { meterEventName } from "./catalog.js";
import { getOrCreateBillingCustomer } from "./customers.js";

/**
 * Metered billing: a call that reports a `key` which is a metered feature of the
 * user's active plan is recorded here, capped, aggregated per billing period and
 * pushed to Stripe as a meter event. The per-period aggregate is authoritative
 * for the hard cap; Stripe only invoices it at the end of the period.
 *
 * The Stripe push is an outbox: the event row keeps `stripe_meter_event_identifier`
 * null until Stripe accepts it, and `pushPendingMeterEvents` retries the pending
 * ones. A Stripe outage therefore never loses usage, and never widens the cap.
 */

/** First day of the current UTC month — the period the hard cap applies to. */
export function billingPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function meteredPriceFor(planId: string, key: string) {
  const [row] = await db
    .select({
      usageLimit: subscriptionPlanPrices.usageLimit,
      unit: subscriptionPlanPrices.unit,
    })
    .from(subscriptionPlanPrices)
    .where(
      and(
        eq(subscriptionPlanPrices.planId, planId),
        eq(subscriptionPlanPrices.billingType, "metered"),
        eq(subscriptionPlanPrices.featureKey, key),
      ),
    )
    .limit(1);
  return row;
}

export interface MeteredUsageInput {
  userId: string;
  applicationId: string;
  key: string;
  value: number;
  /** Caller-provided retry key; a random one is used when absent. */
  idempotencyKey?: string;
}

/**
 * Record metered usage for a user's active plan, or return `null` when the key
 * is not a metered feature of that plan (the caller then uses the free metric
 * path). Throws `BIL_003` when the report would cross the hard cap.
 */
export async function recordMeteredUsage(
  input: MeteredUsageInput,
): Promise<{ key: string; total: string } | null> {
  const [subscription] = await db
    .select({ planId: userSubscriptions.planId })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, input.userId),
        eq(userSubscriptions.applicationId, input.applicationId),
        eq(userSubscriptions.isActive, true),
      ),
    )
    .limit(1);
  if (!subscription) return null;

  const price = await meteredPriceFor(subscription.planId, input.key);
  if (!price) return null;
  if (!(input.value > 0)) {
    throw ERR.BIL_002("Metered usage must be a positive quantity");
  }

  const [app] = await db
    .select({ slug: applications.slug })
    .from(applications)
    .where(eq(applications.id, input.applicationId))
    .limit(1);
  if (!app) return null;

  const period = billingPeriodStart();
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const limit = price.usageLimit;
  const periodKey = and(
    eq(billingUsagePeriods.userId, input.userId),
    eq(billingUsagePeriods.applicationId, input.applicationId),
    eq(billingUsagePeriods.featureKey, input.key),
    eq(billingUsagePeriods.billingPeriodStart, period),
  );

  let eventId: string | null = null;
  let total = "0";

  await db.transaction(async (tx) => {
    // Insert first: a duplicate (retry) must not increment the aggregate again.
    const [event] = await tx
      .insert(billingUsageEvents)
      .values({
        applicationId: input.applicationId,
        userId: input.userId,
        featureKey: input.key,
        quantity: String(input.value),
        billingPeriodStart: period,
        idempotencyKey,
      })
      .onConflictDoNothing({
        target: [
          billingUsageEvents.applicationId,
          billingUsageEvents.idempotencyKey,
        ],
      })
      .returning({ id: billingUsageEvents.id });

    if (!event) {
      const [current] = await tx
        .select({ quantity: billingUsagePeriods.quantity })
        .from(billingUsagePeriods)
        .where(periodKey)
        .limit(1);
      total = current?.quantity ?? "0";
      return;
    }

    const [aggregate] = await tx
      .insert(billingUsagePeriods)
      .values({
        userId: input.userId,
        applicationId: input.applicationId,
        featureKey: input.key,
        billingPeriodStart: period,
        quantity: String(input.value),
      })
      .onConflictDoUpdate({
        target: [
          billingUsagePeriods.userId,
          billingUsagePeriods.applicationId,
          billingUsagePeriods.featureKey,
          billingUsagePeriods.billingPeriodStart,
        ],
        set: {
          quantity: sql`${billingUsagePeriods.quantity} + ${String(input.value)}`,
          updatedAt: new Date(),
        },
      })
      .returning({ quantity: billingUsagePeriods.quantity });

    if (limit !== null && limit >= 0 && Number(aggregate!.quantity) > limit) {
      // Rolls back both the increment and the event: refused usage is not billed.
      throw ERR.BIL_003();
    }
    eventId = event.id;
    total = aggregate!.quantity;
  });

  if (eventId) {
    await pushMeterEvent({
      eventId,
      userId: input.userId,
      appSlug: app.slug,
      featureKey: input.key,
      value: input.value,
    });
  }
  return { key: input.key, total };
}

async function pushMeterEvent(input: {
  eventId: string;
  userId: string;
  appSlug: string;
  featureKey: string;
  value: number;
}): Promise<void> {
  if (!stripe) return;
  try {
    const customer = await getOrCreateBillingCustomer("user", input.userId);
    await stripe.billing.meterEvents.create({
      event_name: meterEventName(input.appSlug, input.featureKey),
      payload: {
        stripe_customer_id: customer.stripeCustomerId,
        value: String(input.value),
      },
      // The event row id is stable, so a retry cannot double-bill.
      identifier: input.eventId,
    });
    await db
      .update(billingUsageEvents)
      .set({ stripeMeterEventIdentifier: input.eventId })
      .where(eq(billingUsageEvents.id, input.eventId));
  } catch (err) {
    logger.warn(
      { err: String(err), eventId: input.eventId },
      "[billing] meter event push failed; the retry job will push it",
    );
  }
}

/** Meter events still waiting for Stripe, for a read-only reconciliation run. */
export async function countPendingMeterEvents(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(billingUsageEvents)
    .where(isNull(billingUsageEvents.stripeMeterEventIdentifier));
  return row?.count ?? 0;
}

/**
 * Push the meter events Stripe has not acknowledged yet. Stops at the first
 * failure (usually systemic) so a Stripe outage does not hammer the API.
 * Returns how many were pushed.
 */
export async function pushPendingMeterEvents(limit = 100): Promise<number> {
  if (!stripe) return 0;
  const rows = await db
    .select({
      id: billingUsageEvents.id,
      userId: billingUsageEvents.userId,
      featureKey: billingUsageEvents.featureKey,
      quantity: billingUsageEvents.quantity,
      appSlug: applications.slug,
    })
    .from(billingUsageEvents)
    .innerJoin(
      applications,
      eq(applications.id, billingUsageEvents.applicationId),
    )
    .where(isNull(billingUsageEvents.stripeMeterEventIdentifier))
    .orderBy(billingUsageEvents.createdAt)
    .limit(limit);

  let pushed = 0;
  for (const row of rows) {
    try {
      const customer = await getOrCreateBillingCustomer("user", row.userId);
      await stripe.billing.meterEvents.create({
        event_name: meterEventName(row.appSlug, row.featureKey),
        payload: {
          stripe_customer_id: customer.stripeCustomerId,
          value: row.quantity,
        },
        identifier: row.id,
      });
      await db
        .update(billingUsageEvents)
        .set({ stripeMeterEventIdentifier: row.id })
        .where(eq(billingUsageEvents.id, row.id));
      pushed += 1;
    } catch (err) {
      logger.warn(
        { err: String(err), eventId: row.id },
        "[billing] pending meter event still failing; retrying later",
      );
      break;
    }
  }
  return pushed;
}

/** Retry the pending meter events now, then every few minutes. Never throws. */
export function startBillingMeterRetry(): void {
  if (!stripe) return;
  const run = () =>
    pushPendingMeterEvents().catch((err: unknown) =>
      logger.warn({ err: String(err) }, "[billing] meter event retry failed"),
    );
  void run();
  setInterval(run, 5 * 60_000).unref();
}
