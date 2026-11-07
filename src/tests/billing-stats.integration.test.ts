import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  billingCustomers,
  stripeEvents,
  stripeInvoices,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import { getBillingStats } from "../services/billing/stats.js";

const DAY_MS = 86_400_000;

let now: Date;

function daysAgo(n: number, hour = 12): Date {
  const d = new Date(now);
  d.setUTCHours(hour, 0, 0, 0);
  return new Date(d.getTime() - n * DAY_MS);
}

async function seedUser(id: string) {
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

interface InvoiceInput {
  id: string;
  applicationId: string | null;
  status: "paid" | "open";
  currency: string;
  amountPaid: number;
  amountRemaining: number;
  at: Date;
  stripeSubscriptionId?: string | null;
}

async function insertInvoice(input: InvoiceInput) {
  await db.insert(stripeInvoices).values({
    stripeInvoiceId: input.id,
    userId: "u1",
    applicationId: input.applicationId,
    status: input.status,
    currency: input.currency,
    amountDue: input.amountPaid + input.amountRemaining,
    amountPaid: input.amountPaid,
    amountRemaining: input.amountRemaining,
    stripeSubscriptionId:
      input.stripeSubscriptionId === undefined
        ? input.applicationId
          ? "sub_test"
          : null
        : input.stripeSubscriptionId,
    stripeCreatedAt: input.at,
    paidAt: input.status === "paid" ? input.at : null,
    lastEventAt: input.at,
  });
}

beforeEach(async () => {
  now = new Date();
  await cleanDb();
});

describe("getBillingStats", () => {
  it("aggregates the local billing cache for the requested range", async () => {
    for (const id of ["u1", "u2", "u3", "u4"]) await seedUser(id);

    const [appA] = await db
      .insert(applications)
      .values({ name: "App A", slug: "app-a", isActive: true })
      .returning();
    const [planA] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: appA!.id,
        name: "Premium",
        stripeProductId: "prod_a",
      })
      .returning();
    const [planB] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: appA!.id, name: "Basic" })
      .returning();

    await db.insert(subscriptionPlanPrices).values([
      {
        planId: planA!.id,
        name: "Monthly",
        amount: "1000",
        currency: "eur",
        stripePriceId: "price_a",
      },
      {
        planId: planB!.id,
        name: "Calls",
        amount: "10",
        currency: "eur",
        billingType: "metered",
        featureKey: "api.calls",
        unit: "call",
        usageLimit: 100,
        stripePriceId: "price_b",
        stripeMeterId: "meter_b",
      },
    ]);

    await db.insert(userSubscriptions).values([
      {
        userId: "u1",
        applicationId: appA!.id,
        planId: planA!.id,
        isActive: true,
        stripeSubscriptionId: "sub_1",
      },
      {
        userId: "u2",
        applicationId: appA!.id,
        planId: planA!.id,
        isActive: true,
        stripeSubscriptionId: "sub_2",
        cancelAtPeriodEnd: true,
      },
      {
        userId: "u3",
        applicationId: appA!.id,
        planId: planB!.id,
        isActive: true,
      },
      {
        userId: "u4",
        applicationId: appA!.id,
        planId: planA!.id,
        isActive: false,
      },
    ]);

    await db.insert(billingCustomers).values([
      { ownerType: "user", ownerId: "u1", stripeCustomerId: "cus_1" },
      { ownerType: "user", ownerId: "u2", stripeCustomerId: "cus_2" },
    ]);

    const today = daysAgo(0);
    const yesterday = daysAgo(1);

    await insertInvoice({
      id: "in_paid_eur_1",
      applicationId: appA!.id,
      status: "paid",
      currency: "eur",
      amountPaid: 1000,
      amountRemaining: 0,
      at: today,
    });
    await insertInvoice({
      id: "in_paid_eur_2",
      applicationId: appA!.id,
      status: "paid",
      currency: "eur",
      amountPaid: 500,
      amountRemaining: 0,
      at: yesterday,
    });
    await insertInvoice({
      id: "in_paid_usd",
      applicationId: appA!.id,
      status: "paid",
      currency: "usd",
      amountPaid: 700,
      amountRemaining: 0,
      at: today,
    });
    // Wallet top-ups carry no application and must not count as revenue.
    await insertInvoice({
      id: "in_wallet",
      applicationId: null,
      status: "paid",
      currency: "eur",
      amountPaid: 9999,
      amountRemaining: 0,
      at: today,
    });
    await insertInvoice({
      id: "in_open_eur_1",
      applicationId: appA!.id,
      status: "open",
      currency: "eur",
      amountPaid: 0,
      amountRemaining: 1500,
      at: today,
    });
    await insertInvoice({
      id: "in_open_eur_2",
      applicationId: appA!.id,
      status: "open",
      currency: "eur",
      amountPaid: 0,
      amountRemaining: 250,
      at: today,
    });
    await insertInvoice({
      id: "in_open_usd",
      applicationId: appA!.id,
      status: "open",
      currency: "usd",
      amountPaid: 0,
      amountRemaining: 999,
      at: today,
    });

    await db.insert(stripeEvents).values([
      { id: "evt_1", type: "invoice.paid", processedAt: daysAgo(0, 1) },
      { id: "evt_2", type: "invoice.paid", processedAt: daysAgo(0, 2) },
      { id: "evt_3", type: "invoice.paid", processedAt: daysAgo(0, 3) },
      { id: "evt_4", type: "invoice.paid", processedAt: daysAgo(3) },
      { id: "evt_5", type: "invoice.paid", processedAt: daysAgo(10) },
    ]);

    const stats = await getBillingStats("30d", now);

    expect(stats.range).toBe("30d");
    expect(stats.currency).toBe("eur");
    expect(stats.revenue.count).toBe(2);
    expect(stats.revenue.total).toBe(1500);
    expect(stats.revenue.series).toHaveLength(30);
    expect(stats.revenue.series.at(-1)).toEqual({
      date: today.toISOString().slice(0, 10),
      amount: 1000,
    });
    expect(stats.revenue.series.at(-2)).toEqual({
      date: yesterday.toISOString().slice(0, 10),
      amount: 500,
    });
    expect(stats.revenue.byCurrency).toEqual([
      { currency: "eur", amount: 1500 },
      { currency: "usd", amount: 700 },
    ]);

    expect(stats.subscriptions).toMatchObject({
      active: 3,
      stripeManaged: 2,
      cancelAtPeriodEnd: 1,
    });
    expect(stats.subscriptions.byPlan).toEqual([
      {
        planId: planA!.id,
        planName: "Premium",
        applicationName: "App A",
        count: 2,
      },
      {
        planId: planB!.id,
        planName: "Basic",
        applicationName: "App A",
        count: 1,
      },
    ]);

    expect(stats.customers).toEqual({ withStripe: 2, users: 4 });
    expect(stats.invoices).toEqual({ openCount: 2, openAmount: 1750 });

    expect(stats.catalog).toEqual({
      plans: 2,
      plansLinked: 1,
      prices: 2,
      pricesLinked: 2,
      metersLinked: 1,
    });

    expect(stats.webhooks.last24h).toBe(3);
    expect(stats.webhooks.last7d).toBe(4);
    expect(stats.webhooks.lastProcessedAt).toBe(daysAgo(0, 3).toISOString());
  });

  it("keeps subscription revenue after the application row is deleted", async () => {
    await seedUser("u1");
    const [appRow] = await db
      .insert(applications)
      .values({ name: "Deleted", slug: "deleted-app", isActive: true })
      .returning();
    await insertInvoice({
      id: "in_deleted_app",
      applicationId: appRow!.id,
      status: "paid",
      currency: "eur",
      amountPaid: 2500,
      amountRemaining: 0,
      at: daysAgo(0),
    });
    await db.delete(applications).where(eq(applications.id, appRow!.id));

    const stats = await getBillingStats("30d", now);

    expect(stats.revenue.total).toBe(2500);
    expect(stats.revenue.count).toBe(1);
  });

  it("does not count expired subscriptions as active", async () => {
    await seedUser("u1");
    await seedUser("u2");
    const [appRow] = await db
      .insert(applications)
      .values({ name: "Expiry", slug: "expiry-app", isActive: true })
      .returning();
    const [planRow] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: appRow!.id,
        name: "Expiring",
        stripeProductId: "prod_expiry",
      })
      .returning();
    await db.insert(userSubscriptions).values([
      {
        userId: "u1",
        applicationId: appRow!.id,
        planId: planRow!.id,
        isActive: true,
        expiresAt: new Date(now.getTime() - 60_000),
      },
      {
        userId: "u2",
        applicationId: appRow!.id,
        planId: planRow!.id,
        isActive: true,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    ]);

    const stats = await getBillingStats("30d", now);

    expect(stats.subscriptions.active).toBe(1);
  });

  it("falls back to the most common price currency when there is no revenue", async () => {
    const [appA] = await db
      .insert(applications)
      .values({ name: "App A", slug: "app-a", isActive: true })
      .returning();
    const [planA] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: appA!.id, name: "Premium" })
      .returning();
    await db.insert(subscriptionPlanPrices).values([
      { planId: planA!.id, name: "Monthly", amount: "1000", currency: "usd" },
      { planId: planA!.id, name: "Yearly", amount: "10000", currency: "usd" },
      { planId: planA!.id, name: "Legacy", amount: "500", currency: "gbp" },
    ]);

    const stats = await getBillingStats("7d", now);

    expect(stats.currency).toBe("usd");
    expect(stats.revenue.total).toBe(0);
    expect(stats.revenue.count).toBe(0);
    expect(stats.revenue.series).toHaveLength(7);
    expect(stats.revenue.byCurrency).toEqual([]);
  });
});
