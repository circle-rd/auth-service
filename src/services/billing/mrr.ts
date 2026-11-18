import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";

export interface PlanPriceInput {
  amount: number;
  currency: string;
  interval: string;
}

/**
 * Monthly-equivalent list price of a plan in one currency: the monthly price
 * when there is one, else the yearly price over twelve. One-off and unlisted
 * currencies do not recur, so they yield null.
 */
export function monthlyEquivalent(
  prices: readonly PlanPriceInput[],
  currency: string,
): number | null {
  const inCurrency = prices.filter((price) => price.currency === currency);
  const monthly = inCurrency.find((price) => price.interval === "month");
  if (monthly) return monthly.amount;
  const yearly = inCurrency.find((price) => price.interval === "year");
  return yearly ? Math.round(yearly.amount / 12) : null;
}

export interface BusinessStats {
  generatedAt: string;
  currency: string;
  // List-price estimate over Stripe-managed active subscriptions, in minor units.
  mrr: number;
  arr: number;
  payingSubscriptions: number;
  unpricedSubscriptions: number;
  byPlan: {
    planId: string;
    planName: string;
    applicationName: string;
    count: number;
    mrr: number;
  }[];
}

export async function getBusinessStats(
  now: Date = new Date(),
): Promise<BusinessStats> {
  const subscriptions = await db
    .select({
      planId: userSubscriptions.planId,
      planName: subscriptionPlans.name,
      applicationName: applications.name,
      count: sql<number>`count(*)::int`,
    })
    .from(userSubscriptions)
    .innerJoin(
      subscriptionPlans,
      eq(userSubscriptions.planId, subscriptionPlans.id),
    )
    .innerJoin(
      applications,
      eq(subscriptionPlans.applicationId, applications.id),
    )
    .where(
      and(
        eq(userSubscriptions.isActive, true),
        isNotNull(userSubscriptions.stripeSubscriptionId),
        or(
          isNull(userSubscriptions.expiresAt),
          gt(userSubscriptions.expiresAt, now),
        ),
      ),
    )
    .groupBy(
      userSubscriptions.planId,
      subscriptionPlans.name,
      applications.name,
    );

  const priceRows =
    subscriptions.length === 0
      ? []
      : await db
          .select({
            planId: subscriptionPlanPrices.planId,
            amount: subscriptionPlanPrices.amount,
            currency: subscriptionPlanPrices.currency,
            interval: subscriptionPlanPrices.interval,
          })
          .from(subscriptionPlanPrices)
          .where(
            and(
              inArray(
                subscriptionPlanPrices.planId,
                subscriptions.map((row) => row.planId),
              ),
              eq(subscriptionPlanPrices.billingType, "fixed"),
            ),
          );

  const pricesByPlan = new Map<string, PlanPriceInput[]>();
  const weightByCurrency = new Map<string, number>();
  for (const row of priceRows) {
    const list = pricesByPlan.get(row.planId) ?? [];
    list.push({
      amount: Number(row.amount),
      currency: row.currency,
      interval: row.interval,
    });
    pricesByPlan.set(row.planId, list);
  }
  for (const sub of subscriptions) {
    for (const currency of new Set(
      (pricesByPlan.get(sub.planId) ?? []).map((price) => price.currency),
    )) {
      weightByCurrency.set(
        currency,
        (weightByCurrency.get(currency) ?? 0) + sub.count,
      );
    }
  }
  // Currencies are never summed: report the one that covers most subscriptions.
  const currency =
    [...weightByCurrency.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? "eur";

  let unpriced = 0;
  const byPlan = subscriptions
    .map((sub) => {
      const unit = monthlyEquivalent(
        pricesByPlan.get(sub.planId) ?? [],
        currency,
      );
      if (unit === null) unpriced += sub.count;
      return {
        planId: sub.planId,
        planName: sub.planName,
        applicationName: sub.applicationName,
        count: sub.count,
        mrr: (unit ?? 0) * sub.count,
      };
    })
    .sort((a, b) => b.mrr - a.mrr || b.count - a.count);

  const mrr = byPlan.reduce((acc, plan) => acc + plan.mrr, 0);
  return {
    generatedAt: new Date().toISOString(),
    currency,
    mrr,
    arr: mrr * 12,
    payingSubscriptions: subscriptions.reduce((acc, sub) => acc + sub.count, 0),
    unpricedSubscriptions: unpriced,
    byPlan,
  };
}
