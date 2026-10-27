import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as EventBusModule from "../services/event-bus.js";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  stripeInvoices,
  subscriptionPlanPrices,
  subscriptionPlans,
  userApplications,
  userSubscriptionEvents,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import { createTestApp } from "./helpers/app.js";
import {
  applyInvoicePaid,
  applyInvoicePaymentFailed,
  cancelSubscription,
  syncSubscription,
  type WebhookLog,
} from "../services/billing/webhooks.js";
import { stripeWebhookRoutes } from "../routes/stripe-webhook.js";

const { constructEvent, stripeHolder, previousWebhookSecret } = vi.hoisted(() => {
  // config is read-only and validated at import time, so the webhook secret
  // must be set before the module graph loads.
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const constructEvent = vi.fn();
  return {
    constructEvent,
    previousWebhookSecret,
    stripeHolder: { stripe: { webhooks: { constructEvent } } as unknown },
  };
});

vi.mock("../services/stripe.js", () => ({
  get stripe() {
    return stripeHolder.stripe;
  },
}));
// Keep the live-notification off the real bus; it is asserted in unit tests.
vi.mock("../services/event-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EventBusModule>();
  return { ...actual, publishEvent: vi.fn() };
});

const log: WebhookLog = { warn: () => {}, debug: () => {} };

const PERIOD_START = 1_735_689_600; // 2025-01-01T00:00:00Z
const PERIOD_END = 1_738_368_000; // 2025-02-01T00:00:00Z
const asDate = (unix: number) => new Date(unix * 1000);

// ── Fixtures ───────────────────────────────────────────────────────────────

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    metadata: { userId: "user-1" },
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: "price_1", product: "prod_1" },
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_1",
    billing_reason: "subscription_cycle",
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    parent: {
      subscription_details: {
        subscription: "sub_1",
        metadata: { userId: "user-1" },
      },
    },
    lines: {
      data: [
        {
          pricing: { price_details: { price: "price_1" } },
          period: { end: PERIOD_END },
        },
      ],
    },
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Invoice;
}

// ── Seeding ────────────────────────────────────────────────────────────────

async function seedUser(id = "user-1") {
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedApp(slug = "test-app") {
  const [a] = await db
    .insert(applications)
    .values({ name: "Test App", slug, isActive: true })
    .returning();
  return a!;
}

async function seedPlan(
  appId: string,
  name = "pro",
  stripeProductId: string | null = null,
) {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: appId, name, features: {}, stripeProductId })
    .returning();
  return plan!;
}

async function seedPrice(planId: string, stripePriceId: string) {
  await db.insert(subscriptionPlanPrices).values({
    planId,
    name: "monthly",
    amount: "1000",
    currency: "eur",
    interval: "month",
    stripePriceId,
  });
}

async function seedAccess(userId: string, appId: string) {
  await db.insert(userApplications).values({
    userId,
    applicationId: appId,
    isActive: true,
    subscriptionPlanId: null,
  });
}

async function seedSubscription(
  userId: string,
  appId: string,
  planId: string,
  isActive = true,
) {
  await db.insert(userSubscriptions).values({
    userId,
    applicationId: appId,
    planId,
    isActive,
    stripeSubscriptionId: "sub_1",
    stripeStatus: isActive ? "active" : "past_due",
  });
}

async function readSubscription(userId: string, appId: string) {
  const [row] = await db
    .select()
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, appId),
      ),
    )
    .limit(1);
  return row;
}

async function readMirror(userId: string, appId: string) {
  const [row] = await db
    .select({ subscriptionPlanId: userApplications.subscriptionPlanId })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, appId),
      ),
    )
    .limit(1);
  return row?.subscriptionPlanId ?? null;
}

async function readAudit(userId: string, appId: string) {
  return db
    .select()
    .from(userSubscriptionEvents)
    .where(
      and(
        eq(userSubscriptionEvents.userId, userId),
        eq(userSubscriptionEvents.applicationId, appId),
      ),
    );
}

beforeEach(async () => {
  await cleanDb();
  constructEvent.mockReset();
});

// ── Handler tests ──────────────────────────────────────────────────────────

describe("syncSubscription", () => {
  it("activates the plan, records the canonical state, mirror and audit", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedPrice(plan.id, "price_1");
    await seedAccess("user-1", a.id);

    await syncSubscription(subscription(), log);

    const row = await readSubscription("user-1", a.id);
    expect(row).toMatchObject({
      planId: plan.id,
      isActive: true,
      stripeSubscriptionId: "sub_1",
      stripeStatus: "active",
      cancelAtPeriodEnd: false,
    });
    expect(row?.currentPeriodStart).toEqual(asDate(PERIOD_START));
    expect(row?.currentPeriodEnd).toEqual(asDate(PERIOD_END));
    expect(row?.expiresAt).toEqual(asDate(PERIOD_END));
    expect(await readMirror("user-1", a.id)).toBe(plan.id);

    const audit = await readAudit("user-1", a.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      source: "stripe",
      action: "assigned",
      fromPlanId: null,
      toPlanId: plan.id,
    });
  });

  it("falls back to the product when the price is unknown", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id, "pro", "prod_1");
    await seedAccess("user-1", a.id);

    await syncSubscription(
      subscription({
        items: {
          data: [
            {
              price: { id: "price_unknown", product: "prod_1" },
              current_period_start: PERIOD_START,
              current_period_end: PERIOD_END,
            },
          ],
        },
      }),
      log,
    );

    expect((await readSubscription("user-1", a.id))?.planId).toBe(plan.id);
  });

  it("deactivates and clears the mirror on a past_due status, keeping the row", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedPrice(plan.id, "price_1");
    await seedAccess("user-1", a.id);
    await seedSubscription("user-1", a.id, plan.id, true);

    await syncSubscription(subscription({ status: "past_due" }), log);

    const row = await readSubscription("user-1", a.id);
    expect(row).toMatchObject({
      planId: plan.id,
      isActive: false,
      stripeStatus: "past_due",
    });
    expect(await readMirror("user-1", a.id)).toBeNull();
    expect((await readAudit("user-1", a.id))[0]).toMatchObject({
      source: "stripe",
      action: "changed",
    });
  });

  it("skips a subscription whose plan cannot be resolved", async () => {
    await seedUser();
    const a = await seedApp();
    await seedAccess("user-1", a.id);

    await syncSubscription(
      subscription({
        items: {
          data: [
            {
              price: { id: "price_x", product: "prod_x" },
              current_period_start: PERIOD_START,
              current_period_end: PERIOD_END,
            },
          ],
        },
      }),
      log,
    );

    expect(await readSubscription("user-1", a.id)).toBeUndefined();
    expect(await readAudit("user-1", a.id)).toHaveLength(0);
  });
});

describe("cancelSubscription", () => {
  it("keeps the row inactive with the cancellation date and clears the mirror", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedAccess("user-1", a.id);
    await seedSubscription("user-1", a.id, plan.id, true);

    await cancelSubscription(
      subscription({ status: "canceled", canceled_at: PERIOD_END }),
      log,
    );

    const row = await readSubscription("user-1", a.id);
    expect(row).toMatchObject({
      planId: plan.id,
      isActive: false,
      stripeStatus: "canceled",
      canceledAt: asDate(PERIOD_END),
    });
    expect(await readMirror("user-1", a.id)).toBeNull();
  });
});

describe("invoice payments", () => {
  it("reactivates the subscription on a paid invoice", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedAccess("user-1", a.id);
    await seedSubscription("user-1", a.id, plan.id, false);

    await applyInvoicePaid(invoice(), log);

    const row = await readSubscription("user-1", a.id);
    expect(row?.isActive).toBe(true);
    expect(row?.expiresAt).toEqual(asDate(PERIOD_END));
    expect(await readMirror("user-1", a.id)).toBe(plan.id);
  });

  it("deactivates on a dunning failure but ignores a proration failure", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedAccess("user-1", a.id);
    await seedSubscription("user-1", a.id, plan.id, true);

    await applyInvoicePaymentFailed(
      invoice({ billing_reason: "subscription_update" }),
      log,
    );
    expect((await readSubscription("user-1", a.id))?.isActive).toBe(true);

    await applyInvoicePaymentFailed(
      invoice({ billing_reason: "subscription_cycle" }),
      log,
    );
    expect((await readSubscription("user-1", a.id))?.isActive).toBe(false);
  });

  it("ignores a one-off invoice with no subscription parent", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedAccess("user-1", a.id);
    await seedSubscription("user-1", a.id, plan.id, false);

    await applyInvoicePaid(invoice({ parent: null }), log);

    expect((await readSubscription("user-1", a.id))?.isActive).toBe(false);
  });
});

// ── Route test (dispatch + idempotency) ────────────────────────────────────

describe("POST /api/webhooks/stripe", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = createTestApp();
    await app.register(stripeWebhookRoutes, { prefix: "/api/webhooks/stripe" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (previousWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
    }
  });

  function post(id: string, type: string, object: unknown) {
    constructEvent.mockReturnValue({
      id,
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    } as Stripe.Event);
    return app.inject({
      method: "POST",
      url: "/api/webhooks/stripe/",
      headers: {
        "stripe-signature": "t=1,v1=test",
        "content-type": "application/json",
      },
      payload: JSON.stringify({}),
    });
  }

  it("applies a subscription event and ignores its duplicate delivery", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id);
    await seedPrice(plan.id, "price_1");
    await seedAccess("user-1", a.id);

    const first = await post("evt_1", "customer.subscription.created", subscription());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true });
    const created = await readSubscription("user-1", a.id);
    expect(created?.planId).toBe(plan.id);

    const second = await post("evt_1", "customer.subscription.created", subscription());
    expect(second.statusCode).toBe(200);
    // The duplicate is acknowledged without re-applying state.
    const after = await readSubscription("user-1", a.id);
    expect(after?.updatedAt).toEqual(created?.updatedAt);
  });

  it("caches an invoice event for the read API, whatever its entitlement effect", async () => {
    await seedUser();
    const a = await seedApp();
    await seedAccess("user-1", a.id);
    const response = await post("evt_inv_1", "invoice.finalized", {
      id: "in_dispatch_1",
      object: "invoice",
      status: "open",
      currency: "eur",
      amount_due: 1500,
      amount_paid: 0,
      amount_remaining: 1500,
      period_start: 1793000000,
      period_end: 1793002592,
      created: 1793000000,
      billing_reason: "subscription_create",
      hosted_invoice_url: "https://invoice.stripe.com/i/dispatch",
      invoice_pdf: "https://pay.stripe.com/invoice/dispatch/pdf",
      customer: "cus_dispatch",
      metadata: { userId: "user-1" },
      parent: null,
    });
    expect(response.statusCode).toBe(200);
    const [row] = await db
      .select({
        userId: stripeInvoices.userId,
        hostedInvoiceUrl: stripeInvoices.hostedInvoiceUrl,
      })
      .from(stripeInvoices)
      .where(eq(stripeInvoices.stripeInvoiceId, "in_dispatch_1"));
    expect(row).toEqual({
      userId: "user-1",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/dispatch",
    });
  });
});
