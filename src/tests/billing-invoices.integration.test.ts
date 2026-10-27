import type * as MachineAuthModule from "../services/machine-auth.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type Stripe from "stripe";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  billingCustomers,
  billingUsagePeriods,
  stripeInvoices,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import { createTestApp } from "./helpers/app.js";
import { billingPeriodStart } from "../services/billing/usage.js";
import { cacheStripeInvoice } from "../services/billing/invoices.js";
import { appBillingRoutes } from "../routes/app-billing.js";

const { authHolder } = vi.hoisted(() => ({
  authHolder: { clientId: null as string | null },
}));

// The real check needs a signed client_credentials token; these tests drive the
// application the token names and keep the real rejection for anonymous calls.
vi.mock("../services/machine-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MachineAuthModule>();
  return {
    ...actual,
    requireMachineScope: vi.fn(async (authorization, scope) => {
      if (authHolder.clientId) return { clientId: authHolder.clientId };
      return actual.requireMachineScope(authorization, scope);
    }),
  };
});

const silentLog = { warn: vi.fn(), debug: vi.fn() };

const T0 = 1_793_000_000; // unix seconds; any fixed base works

function invoice(
  overrides: Partial<Stripe.Invoice> & { id: string },
): Stripe.Invoice {
  return {
    object: "invoice",
    status: "open",
    currency: "eur",
    amount_due: 1500,
    amount_paid: 0,
    amount_remaining: 1500,
    period_start: T0,
    period_end: T0 + 2_592_000,
    created: T0,
    billing_reason: "subscription_cycle",
    hosted_invoice_url: null,
    invoice_pdf: null,
    customer: "cus_u1",
    metadata: {},
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: "sub_a",
        metadata: {},
      },
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

const app = createTestApp();

beforeAll(async () => {
  await app.register(appBillingRoutes, { prefix: "/api/app/billing" });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  authHolder.clientId = null;
  silentLog.warn.mockClear();
});

async function seed() {
  for (const id of ["u1", "u2"]) {
    await db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  await db.insert(billingCustomers).values({
    ownerType: "user",
    ownerId: "u1",
    stripeCustomerId: "cus_u1",
  });
  const [appA] = await db
    .insert(applications)
    .values({ name: "App A", slug: "app-a", isActive: true })
    .returning();
  const [appB] = await db
    .insert(applications)
    .values({ name: "App B", slug: "app-b", isActive: true })
    .returning();
  const [planA] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: appA!.id, name: "premium", isDefault: false })
    .returning();
  await db.insert(userSubscriptions).values({
    userId: "u1",
    applicationId: appA!.id,
    planId: planA!.id,
    stripeSubscriptionId: "sub_a",
    stripeStatus: "active",
    currentPeriodStart: new Date(T0 * 1000),
    currentPeriodEnd: new Date((T0 + 2_592_000) * 1000),
  });
  return { appA: appA!, appB: appB!, planA: planA! };
}

describe("cacheStripeInvoice", () => {
  it("caches a subscription invoice under its user and application", async () => {
    const { appA } = await seed();
    expect(
      await cacheStripeInvoice(invoice({ id: "in_1" }), T0, silentLog),
    ).toBe(true);
    const [row] = await db.select().from(stripeInvoices);
    expect(row).toMatchObject({
      stripeInvoiceId: "in_1",
      userId: "u1",
      applicationId: appA.id,
      stripeSubscriptionId: "sub_a",
      status: "open",
      billingReason: "subscription_cycle",
      amountDue: 1500,
      amountRemaining: 1500,
    });
  });

  it("fills the hosted link and PDF when the finalized event arrives", async () => {
    await seed();
    await cacheStripeInvoice(invoice({ id: "in_1" }), T0, silentLog);
    await cacheStripeInvoice(
      invoice({
        id: "in_1",
        status: "open",
        hosted_invoice_url: "https://invoice.stripe.com/i/x",
        invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
      }),
      T0 + 5,
      silentLog,
    );
    const [row] = await db.select().from(stripeInvoices);
    expect(row?.hostedInvoiceUrl).toBe("https://invoice.stripe.com/i/x");
    expect(row?.invoicePdf).toBe("https://pay.stripe.com/invoice/x/pdf");
  });

  it("ignores an older event delivered after a newer one", async () => {
    await seed();
    await cacheStripeInvoice(
      invoice({ id: "in_1", status: "paid", amount_paid: 1500, amount_remaining: 0 }),
      T0 + 10,
      silentLog,
    );
    await cacheStripeInvoice(invoice({ id: "in_1", status: "open" }), T0 + 1, silentLog);
    const [row] = await db.select().from(stripeInvoices);
    expect(row).toMatchObject({ status: "paid", amountPaid: 1500 });
  });

  it("caches a wallet top-up invoice with no application", async () => {
    await seed();
    await cacheStripeInvoice(
      invoice({
        id: "in_wallet",
        customer: "cus_unknown",
        billing_reason: "manual",
        parent: null,
        metadata: { purpose: "wallet_topup", userId: "u1" },
      } as never),
      T0,
      silentLog,
    );
    const [row] = await db.select().from(stripeInvoices);
    expect(row).toMatchObject({ userId: "u1", applicationId: null });
  });

  it("falls back to the subscription metadata when the subscription row is not there yet", async () => {
    const { appB } = await seed();
    await cacheStripeInvoice(
      invoice({
        id: "in_early",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_unknown",
            metadata: { userId: "u1", applicationId: appB.id },
          },
        } as never,
      }),
      T0,
      silentLog,
    );
    const [row] = await db.select().from(stripeInvoices);
    expect(row?.applicationId).toBe(appB.id);
  });

  it("refuses to cache an invoice whose owner cannot be resolved", async () => {
    await seed();
    const cached = await cacheStripeInvoice(
      invoice({ id: "in_orphan", customer: "cus_nobody", parent: null } as never),
      T0,
      silentLog,
    );
    expect(cached).toBe(false);
    expect(silentLog.warn).toHaveBeenCalledOnce();
    expect(await db.select().from(stripeInvoices)).toHaveLength(0);
  });
});

describe("application read API", () => {
  async function get(url: string) {
    return app.inject({ method: "GET", url });
  }

  it("lists only the calling application's invoices", async () => {
    await seed();
    await cacheStripeInvoice(invoice({ id: "in_a" }), T0, silentLog);
    await cacheStripeInvoice(
      invoice({ id: "in_wallet", parent: null, metadata: { purpose: "wallet_topup", userId: "u1" } } as never),
      T0,
      silentLog,
    );

    authHolder.clientId = "app-a";
    const mine = await get("/api/app/billing/users/u1/invoices");
    expect(mine.statusCode).toBe(200);
    expect(mine.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([
      "in_a",
    ]);

    authHolder.clientId = "app-b";
    const other = await get("/api/app/billing/users/u1/invoices");
    expect(other.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("paginates newest first with no repeated or skipped invoice", async () => {
    await seed();
    for (let i = 0; i < 5; i += 1) {
      await cacheStripeInvoice(
        invoice({ id: `in_${i}`, created: T0 + i }),
        T0 + i,
        silentLog,
      );
    }
    authHolder.clientId = "app-a";
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url =
        `/api/app/billing/users/u1/invoices?limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res = await get(url);
      const body = res.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["in_4", "in_3", "in_2", "in_1", "in_0"]);
  });

  it("rejects a malformed cursor", async () => {
    await seed();
    authHolder.clientId = "app-a";
    const res = await get("/api/app/billing/users/u1/invoices?cursor=%%%");
    expect(res.statusCode).toBe(400);
  });

  it("returns the user's subscription for the calling application only", async () => {
    await seed();
    authHolder.clientId = "app-a";
    const mine = await get("/api/app/billing/users/u1/subscription");
    expect(mine.json<{ subscription: { plan: { name: string }; stripeStatus: string } }>().subscription)
      .toMatchObject({ plan: { name: "premium" }, stripeStatus: "active" });

    authHolder.clientId = "app-b";
    const other = await get("/api/app/billing/users/u1/subscription");
    expect(other.json<{ subscription: unknown }>().subscription).toBeNull();
  });

  it("reports the current period's metered usage against the cap", async () => {
    const { appA, planA } = await seed();
    await db.insert(subscriptionPlanPrices).values({
      planId: planA.id,
      name: "Calls",
      amount: "10",
      interval: "month",
      billingType: "metered",
      featureKey: "api.calls",
      unit: "call",
      usageLimit: 100,
      stripePriceId: "price_m",
      stripeMeterId: "meter_m",
    });
    await db.insert(billingUsagePeriods).values({
      userId: "u1",
      applicationId: appA.id,
      featureKey: "api.calls",
      billingPeriodStart: billingPeriodStart(),
      quantity: "30",
    });
    authHolder.clientId = "app-a";
    const res = await get("/api/app/billing/users/u1/usage");
    expect(res.json()).toMatchObject({
      features: [
        { featureKey: "api.calls", unit: "call", usageLimit: 100, used: 30, remaining: 70 },
      ],
    });
  });

  it("refuses an anonymous call", async () => {
    await seed();
    const res = await get("/api/app/billing/users/u1/invoices");
    expect(res.statusCode).toBe(401);
  });

  it("refuses a token whose application is unknown", async () => {
    await seed();
    authHolder.clientId = "no-such-app";
    const res = await get("/api/app/billing/users/u1/invoices");
    expect(res.statusCode).toBe(404);
  });
});
