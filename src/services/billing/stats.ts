import {
  and,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import {
  applications,
  billingCustomers,
  stripeEvents,
  stripeInvoices,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import {
  denseDailySeries,
  rangeStart,
  rangeToDays,
  type StatsRange,
} from "../daily-series.js";

export interface BillingStats {
  range: StatsRange;
  generatedAt: string;
  currency: string;
  revenue: {
    total: number;
    count: number;
    series: { date: string; amount: number }[];
    byCurrency: { currency: string; amount: number }[];
  };
  subscriptions: {
    active: number;
    stripeManaged: number;
    cancelAtPeriodEnd: number;
    byPlan: {
      planId: string;
      planName: string;
      applicationName: string;
      count: number;
    }[];
  };
  customers: { withStripe: number; users: number };
  invoices: { openCount: number; openAmount: number };
  catalog: {
    plans: number;
    plansLinked: number;
    prices: number;
    pricesLinked: number;
    metersLinked: number;
  };
  webhooks: {
    last24h: number;
    last7d: number;
    lastProcessedAt: string | null;
  };
}

interface RevenueRow {
  day: string;
  currency: string;
  amount: string;
  count: number;
}

async function primaryCurrencyFallback(): Promise<string> {
  const [row] = await db
    .select({ currency: subscriptionPlanPrices.currency, total: count() })
    .from(subscriptionPlanPrices)
    .groupBy(subscriptionPlanPrices.currency)
    .orderBy(desc(count()), subscriptionPlanPrices.currency)
    .limit(1);
  return row?.currency ?? "eur";
}

async function revenueStats(days: number, anchor: Date) {
  const since = rangeStart(days, anchor);
  // Raw aggregate via sql`` because date_trunc is not exposed by the typed
  // builder; every input here is server-controlled (no user concatenation).
  const rows = (await db.execute(
    sql`SELECT to_char(date_trunc('day', stripe_created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               currency,
               COALESCE(SUM(amount_paid), 0)::bigint AS amount,
               COUNT(*)::int AS count
        FROM stripe_invoices
        WHERE status = 'paid'
          AND stripe_subscription_id IS NOT NULL
          AND COALESCE(paid_at, stripe_created_at) >= ${since.toISOString()}::timestamptz
        GROUP BY day, currency
        ORDER BY day ASC`,
  )) as unknown as RevenueRow[];

  const byCurrency = new Map<string, number>();
  // Selecting by invoice count is a non-monetary rule: raw minor-unit totals
  // in different currencies are not comparable.
  const countByCurrency = new Map<string, number>();
  for (const r of rows) {
    byCurrency.set(
      r.currency,
      (byCurrency.get(r.currency) ?? 0) + Number(r.amount),
    );
    countByCurrency.set(
      r.currency,
      (countByCurrency.get(r.currency) ?? 0) + r.count,
    );
  }

  let currency: string;
  if (countByCurrency.size > 0) {
    currency = [...countByCurrency.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]![0];
  } else {
    currency = await primaryCurrencyFallback();
  }

  const forCurrency = rows.filter((r) => r.currency === currency);
  const series = denseDailySeries(
    forCurrency.map((r) => ({ day: r.day, value: Number(r.amount) })),
    days,
    0,
    anchor,
  ).map((p) => ({ date: p.date, amount: p.value }));

  return {
    currency,
    revenue: {
      total: series.reduce((acc, p) => acc + p.amount, 0),
      count: forCurrency.reduce((acc, r) => acc + r.count, 0),
      series,
      byCurrency: [...byCurrency.entries()]
        .map(([code, amount]) => ({ currency: code, amount }))
        .sort((a, b) => b.amount - a.amount),
    },
  };
}

function activeSubscription(now: Date) {
  return and(
    eq(userSubscriptions.isActive, true),
    or(
      isNull(userSubscriptions.expiresAt),
      gt(userSubscriptions.expiresAt, now),
    ),
  );
}

async function subscriptionStats(now: Date) {
  const activePredicate = activeSubscription(now);
  const [active] = await db
    .select({ count: count() })
    .from(userSubscriptions)
    .where(activePredicate);
  const [stripeManaged] = await db
    .select({ count: count() })
    .from(userSubscriptions)
    .where(
      and(activePredicate, isNotNull(userSubscriptions.stripeSubscriptionId)),
    );
  const [cancelAtPeriodEnd] = await db
    .select({ count: count() })
    .from(userSubscriptions)
    .where(and(activePredicate, eq(userSubscriptions.cancelAtPeriodEnd, true)));

  const byPlan = await db
    .select({
      planId: userSubscriptions.planId,
      planName: subscriptionPlans.name,
      applicationName: applications.name,
      count: count(),
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
    .where(activePredicate)
    .groupBy(
      userSubscriptions.planId,
      subscriptionPlans.name,
      applications.name,
    )
    .orderBy(desc(count()), subscriptionPlans.name)
    .limit(5);

  return {
    active: active?.count ?? 0,
    stripeManaged: stripeManaged?.count ?? 0,
    cancelAtPeriodEnd: cancelAtPeriodEnd?.count ?? 0,
    byPlan,
  };
}

async function catalogStats() {
  const [plans] = await db
    .select({
      plans: count(),
      plansLinked: sql<number>`count(*) FILTER (WHERE ${subscriptionPlans.stripeProductId} IS NOT NULL)::int`,
    })
    .from(subscriptionPlans);
  const [prices] = await db
    .select({
      prices: count(),
      pricesLinked: sql<number>`count(*) FILTER (WHERE ${subscriptionPlanPrices.stripePriceId} IS NOT NULL)::int`,
      metersLinked: sql<number>`count(*) FILTER (WHERE ${subscriptionPlanPrices.stripeMeterId} IS NOT NULL)::int`,
    })
    .from(subscriptionPlanPrices);

  return {
    plans: plans?.plans ?? 0,
    plansLinked: plans?.plansLinked ?? 0,
    prices: prices?.prices ?? 0,
    pricesLinked: prices?.pricesLinked ?? 0,
    metersLinked: prices?.metersLinked ?? 0,
  };
}

async function webhookStats() {
  const [row] = await db
    .select({
      last24h: sql<number>`count(*) FILTER (WHERE ${stripeEvents.processedAt} >= now() - interval '24 hours')::int`,
      last7d: sql<number>`count(*) FILTER (WHERE ${stripeEvents.processedAt} >= now() - interval '7 days')::int`,
      lastProcessedAt: sql<Date | null>`max(${stripeEvents.processedAt})`,
    })
    .from(stripeEvents);

  return {
    last24h: row?.last24h ?? 0,
    last7d: row?.last7d ?? 0,
    lastProcessedAt: row?.lastProcessedAt
      ? new Date(row.lastProcessedAt).toISOString()
      : null,
  };
}

export async function getBillingStats(
  range: StatsRange,
  now: Date = new Date(),
): Promise<BillingStats> {
  const days = rangeToDays(range);
  const { currency, revenue } = await revenueStats(days, now);
  const [subscriptions, catalog, webhooks, customerRows, userRows, openRows] =
    await Promise.all([
      subscriptionStats(now),
      catalogStats(),
      webhookStats(),
      db
        .select({ count: count() })
        .from(billingCustomers)
        .where(eq(billingCustomers.ownerType, "user")),
      db.select({ count: count() }).from(user),
      db
        .select({
          openCount: count(),
          openAmount: sql<string>`COALESCE(SUM(${stripeInvoices.amountRemaining}), 0)::bigint`,
        })
        .from(stripeInvoices)
        .where(
          and(
            eq(stripeInvoices.status, "open"),
            eq(stripeInvoices.currency, currency),
          ),
        ),
    ]);

  return {
    range,
    generatedAt: new Date().toISOString(),
    currency,
    revenue,
    subscriptions,
    customers: {
      withStripe: customerRows[0]?.count ?? 0,
      users: userRows[0]?.count ?? 0,
    },
    invoices: {
      openCount: openRows[0]?.openCount ?? 0,
      openAmount: Number(openRows[0]?.openAmount ?? 0),
    },
    catalog,
    webhooks,
  };
}
