import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  billingUsagePeriods,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import { billingPeriodStart } from "./usage.js";

/**
 * Read views for the application read API. Every function takes the calling
 * application's id: a user's subscription, usage and invoices are only ever
 * described for the application that asks, never for another one.
 */

export interface ApplicationSubscriptionView {
  plan: { id: string; name: string };
  isActive: boolean;
  expiresAt: string | null;
  stripeStatus: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
}

export async function getApplicationSubscription(input: {
  userId: string;
  applicationId: string;
}): Promise<ApplicationSubscriptionView | null> {
  const [row] = await db
    .select({
      planId: subscriptionPlans.id,
      planName: subscriptionPlans.name,
      isActive: userSubscriptions.isActive,
      expiresAt: userSubscriptions.expiresAt,
      stripeStatus: userSubscriptions.stripeStatus,
      currentPeriodStart: userSubscriptions.currentPeriodStart,
      currentPeriodEnd: userSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: userSubscriptions.cancelAtPeriodEnd,
      canceledAt: userSubscriptions.canceledAt,
    })
    .from(userSubscriptions)
    .innerJoin(
      subscriptionPlans,
      eq(userSubscriptions.planId, subscriptionPlans.id),
    )
    .where(
      and(
        eq(userSubscriptions.userId, input.userId),
        eq(userSubscriptions.applicationId, input.applicationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    plan: { id: row.planId, name: row.planName },
    isActive: row.isActive,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    stripeStatus: row.stripeStatus,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt?.toISOString() ?? null,
  };
}

export interface ApplicationUsageFeature {
  featureKey: string;
  unit: string | null;
  /** The plan's hard cap for the period; -1 means unlimited. */
  usageLimit: number;
  used: number;
  /** Units left before the cap; null when unlimited. */
  remaining: number | null;
}

export interface ApplicationUsageView {
  periodStart: string;
  features: ApplicationUsageFeature[];
}

/**
 * Metered usage of the current UTC billing period, for each metered feature the
 * user's plan prices in this application. Empty when the user holds no plan.
 */
export async function getApplicationUsage(input: {
  userId: string;
  applicationId: string;
  now?: Date;
}): Promise<ApplicationUsageView> {
  const periodStart = billingPeriodStart(input.now);
  const [subscription] = await db
    .select({ planId: userSubscriptions.planId })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, input.userId),
        eq(userSubscriptions.applicationId, input.applicationId),
      ),
    )
    .limit(1);
  if (!subscription) {
    return { periodStart: periodStart.toISOString(), features: [] };
  }

  const metered = await db
    .select({
      featureKey: subscriptionPlanPrices.featureKey,
      unit: subscriptionPlanPrices.unit,
      usageLimit: subscriptionPlanPrices.usageLimit,
    })
    .from(subscriptionPlanPrices)
    .where(
      and(
        eq(subscriptionPlanPrices.planId, subscription.planId),
        eq(subscriptionPlanPrices.billingType, "metered"),
      ),
    );

  const used = await db
    .select({
      featureKey: billingUsagePeriods.featureKey,
      quantity: billingUsagePeriods.quantity,
    })
    .from(billingUsagePeriods)
    .where(
      and(
        eq(billingUsagePeriods.userId, input.userId),
        eq(billingUsagePeriods.applicationId, input.applicationId),
        eq(billingUsagePeriods.billingPeriodStart, periodStart),
      ),
    );
  const usedByFeature = new Map(
    used.map((u) => [u.featureKey, Number(u.quantity)]),
  );

  const features = metered
    .filter(
      (m): m is typeof m & { featureKey: string } => m.featureKey !== null,
    )
    .map((m) => {
      const usageLimit = m.usageLimit ?? -1;
      const consumed = usedByFeature.get(m.featureKey) ?? 0;
      return {
        featureKey: m.featureKey,
        unit: m.unit,
        usageLimit,
        used: consumed,
        remaining: usageLimit < 0 ? null : Math.max(0, usageLimit - consumed),
      };
    });

  return { periodStart: periodStart.toISOString(), features };
}
