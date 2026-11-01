import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  billingCustomers,
  stripeInvoices,
  subscriptionPlanPrices,
  subscriptionPlans,
  userApplications,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { makeSuperadminSession, makeUserSession } from "./helpers/auth.js";
import { auth } from "../auth.js";
import {
  applyInvoicePaid,
  cancelSubscription,
  completeSubscriptionCheckout,
} from "../services/billing/webhooks.js";
import { createSubscriptionCheckout } from "../services/billing/subscriptions.js";
import { cacheStripeInvoice } from "../services/billing/invoices.js";

// Every Stripe call is recorded; each test decides what the subscriptions look like.
const { holder, calls } = vi.hoisted(() => {
  const calls: { op: string; args: unknown[] }[] = [];
  const record = (op: string, ...args: unknown[]) => {
    calls.push({ op, args });
  };
  const holder = {
    subscriptions: {} as Record<string, Stripe.Subscription>,
    stripe: null as unknown,
  };
  const stripe = {
    customers: {
      update: async (id: string, params: unknown) => {
        record("customer.update", id, params);
        return { id };
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        record("retrieve", id);
        const found = holder.subscriptions[id];
        if (!found) throw new Error(`no such subscription ${id}`);
        return found;
      },
      update: async (id: string, params: unknown) => {
        record("update", id, params);
        return { id };
      },
      cancel: async (id: string) => {
        record("cancel", id);
        return { id, status: "canceled" };
      },
    },
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          record("checkout.create", params);
          return { id: "cs_new", url: "https://checkout.stripe.test/new" };
        },
      },
    },
  };
  holder.stripe = stripe;
  return { holder, calls };
});

vi.mock("../services/stripe.js", () => ({
  get stripe() {
    return holder.stripe;
  },
  isStripeConfigured: () => holder.stripe !== null,
}));

const silentLog = { warn: vi.fn(), debug: vi.fn() };
const T0 = 1_793_000_000;

function subscription(
  id: string,
  status: string,
  priceId: string,
  metadata: Record<string, string> = {},
): Stripe.Subscription {
  return {
    id,
    object: "subscription",
    status,
    items: {
      data: [
        {
          id: `si_${priceId}`,
          price: { id: priceId, product: "prod_x" },
          current_period_start: T0,
          current_period_end: T0 + 2_592_000,
        },
      ],
    },
    cancel_at_period_end: false,
    canceled_at: null,
    metadata,
  } as unknown as Stripe.Subscription;
}

let handle: AuthServerHandle;

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(() => handle.cleanup());

beforeEach(async () => {
  await cleanDb();
  calls.length = 0;
  holder.subscriptions = {};
  silentLog.warn.mockClear();
  vi.restoreAllMocks();
});

interface Seed {
  appId: string;
  freeId: string;
  proId: string;
  premiumId: string;
}

/** An application with a free and two paid plans, and user u1 linked to `subscriptionId`. */
async function seed(linked: {
  subscriptionId: string | null;
  planId: "free" | "pro";
}): Promise<Seed> {
  for (const [id, name] of [
    ["u1", "Ada"],
    ["u2", "Bob"],
  ] as const) {
    await db.insert(user).values({
      id,
      name,
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
  const [app] = await db
    .insert(applications)
    .values({ name: "Acme", slug: "acme", isActive: true })
    .returning();
  const [free] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app!.id, name: "free", isDefault: true })
    .returning();
  const [pro] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app!.id, name: "pro" })
    .returning();
  const [premium] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app!.id, name: "premium" })
    .returning();
  await db.insert(subscriptionPlanPrices).values([
    { planId: free!.id, name: "Free", amount: "0", interval: "month", billingType: "fixed", stripePriceId: "price_free" },
    { planId: pro!.id, name: "Pro", amount: "1000", interval: "month", billingType: "fixed", stripePriceId: "price_pro" },
    { planId: premium!.id, name: "Premium", amount: "2000", interval: "month", billingType: "fixed", stripePriceId: "price_premium" },
  ]);
  await db.insert(userApplications).values({ userId: "u1", applicationId: app!.id });
  await db.insert(userSubscriptions).values({
    userId: "u1",
    applicationId: app!.id,
    planId: linked.planId === "pro" ? pro!.id : free!.id,
    isActive: true,
    stripeSubscriptionId: linked.subscriptionId,
    stripeStatus: "active",
  });
  return { appId: app!.id, freeId: free!.id, proId: pro!.id, premiumId: premium!.id };
}

async function row() {
  const [r] = await db
    .select({
      planId: userSubscriptions.planId,
      isActive: userSubscriptions.isActive,
      stripeSubscriptionId: userSubscriptions.stripeSubscriptionId,
      cancelAtPeriodEnd: userSubscriptions.cancelAtPeriodEnd,
    })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, "u1"));
  return r!;
}

describe("a superseded subscription cannot rewrite the entitlement", () => {
  it("ignores the deletion of a free subscription replaced by a paid one", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    holder.subscriptions.sub_free = subscription("sub_free", "canceled", "price_free", {
      userId: "u1",
      applicationId: s.appId,
      planId: s.freeId,
    });

    await cancelSubscription(holder.subscriptions.sub_free!, silentLog);

    expect(await row()).toMatchObject({ planId: s.proId, isActive: true, stripeSubscriptionId: "sub_paid" });
  });

  it("ignores a paid invoice of a free subscription replaced by a paid one", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    const invoice = {
      id: "in_free_cycle",
      status: "paid",
      billing_reason: "subscription_cycle",
      period_start: T0,
      period_end: T0 + 2_592_000,
      customer: "cus_u1",
      metadata: {},
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: "sub_free",
          metadata: { userId: "u1", applicationId: s.appId, planId: s.freeId },
        },
      },
      lines: { data: [{ pricing: { price_details: { price: "price_free" } } }] },
    } as unknown as Stripe.Invoice;

    await applyInvoicePaid(invoice, silentLog);

    expect(await row()).toMatchObject({ planId: s.proId, isActive: true });
  });
});

describe("subscription checkout completion", () => {
  it("replaces a free subscription: links the paid one, then cancels the free one", async () => {
    const s = await seed({ subscriptionId: "sub_free", planId: "free" });
    holder.subscriptions.sub_new = subscription("sub_new", "active", "price_pro");
    holder.subscriptions.sub_free = subscription("sub_free", "active", "price_free");

    await completeSubscriptionCheckout(
      {
        id: "cs_1",
        mode: "subscription",
        subscription: "sub_new",
        metadata: { purpose: "subscription", userId: "u1", applicationId: s.appId, planId: s.proId },
      } as unknown as Stripe.Checkout.Session,
      silentLog,
    );

    expect(await row()).toMatchObject({ planId: s.proId, isActive: true, stripeSubscriptionId: "sub_new" });
    const order = calls.map((c) => `${c.op}:${String(c.args[0])}`);
    // The link moves to the new subscription before the free one is cancelled.
    expect(order.indexOf("retrieve:sub_new")).toBeLessThan(order.indexOf("cancel:sub_free"));
    expect(calls.filter((c) => c.op === "cancel").map((c) => c.args[0])).toEqual(["sub_free"]);
  });

  it("refuses a checkout over a live paid subscription", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    holder.subscriptions.sub_new = subscription("sub_new", "active", "price_premium");

    await completeSubscriptionCheckout(
      {
        id: "cs_2",
        mode: "subscription",
        subscription: "sub_new",
        metadata: { purpose: "subscription", userId: "u1", applicationId: s.appId, planId: s.premiumId },
      } as unknown as Stripe.Checkout.Session,
      silentLog,
    );

    expect(await row()).toMatchObject({ planId: s.proId, stripeSubscriptionId: "sub_paid" });
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
  });
});

describe("starting a paid subscription", () => {
  it("refuses a second checkout while a paid subscription is live", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    await expect(
      createSubscriptionCheckout({ userId: "u1", applicationId: s.appId, planId: s.premiumId }),
    ).rejects.toMatchObject({ code: "SUB_007" });
    expect(calls.some((c) => c.op === "checkout.create")).toBe(false);
  });

  it("refuses a checkout for a free plan", async () => {
    const s = await seed({ subscriptionId: "sub_free", planId: "free" });
    await expect(
      createSubscriptionCheckout({ userId: "u1", applicationId: s.appId, planId: s.freeId }),
    ).rejects.toMatchObject({ code: "BIL_002" });
  });
});

describe("PATCH /api/user/subscription/:applicationId", () => {
  function patch(appId: string, planId: string) {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(makeUserSession("u1") as never);
    return handle.app.inject({
      method: "PATCH",
      url: `/api/user/subscription/${appId}`,
      payload: { planId },
    });
  }

  it("starts a Checkout for a paid plan when there is no live paid subscription", async () => {
    const s = await seed({ subscriptionId: "sub_free", planId: "free" });
    holder.subscriptions.sub_free = subscription("sub_free", "active", "price_free");

    const res = await patch(s.appId, s.proId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      changed: false,
      pending: false,
      checkoutUrl: "https://checkout.stripe.test/new",
    });
    // The plan is not granted locally: the checkout's completion grants it.
    expect(await row()).toMatchObject({ planId: s.freeId });
  });

  it("changes a live paid subscription in place, and leaves the plan to the update event", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    holder.subscriptions.sub_paid = subscription("sub_paid", "active", "price_pro");

    const res = await patch(s.appId, s.premiumId);

    expect(res.json()).toMatchObject({ ok: true, pending: true, checkoutUrl: null });
    const update = calls.find((c) => c.op === "update")!;
    expect(update.args[0]).toBe("sub_paid");
    expect(update.args[1]).toMatchObject({
      items: [{ id: "si_price_pro", price: "price_premium" }],
      proration_behavior: "create_prorations",
    });
    expect(await row()).toMatchObject({ planId: s.proId });
  });

  it("applies a change to a free plan at once and moves the Stripe subscription with it", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    holder.subscriptions.sub_paid = subscription("sub_paid", "active", "price_pro");

    const res = await patch(s.appId, s.freeId);

    expect(res.json()).toMatchObject({ ok: true, changed: true, pending: false });
    expect(await row()).toMatchObject({ planId: s.freeId });
    expect(calls.find((c) => c.op === "update")!.args[1]).toMatchObject({
      items: [{ id: "si_price_pro", price: "price_free" }],
    });
  });
});

describe("administrator cancellation at period end", () => {
  it("stops and resumes a subscription, flagging the row at once", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(makeSuperadminSession("sa-1") as never);

    const stop = await handle.app.inject({
      method: "POST",
      url: `/api/admin/applications/${s.appId}/users/u1/subscription/cancel`,
    });
    expect(stop.statusCode).toBe(200);
    expect(calls.find((c) => c.op === "update")!.args[1]).toEqual({ cancel_at_period_end: true });
    expect(await row()).toMatchObject({ cancelAtPeriodEnd: true });

    const resume = await handle.app.inject({
      method: "POST",
      url: `/api/admin/applications/${s.appId}/users/u1/subscription/resume`,
    });
    expect(resume.statusCode).toBe(200);
    expect(await row()).toMatchObject({ cancelAtPeriodEnd: false });
  });

  it("answers 404 SUB_008 when the user has no Stripe subscription", async () => {
    const s = await seed({ subscriptionId: null, planId: "free" });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(makeSuperadminSession("sa-1") as never);
    const res = await handle.app.inject({
      method: "POST",
      url: `/api/admin/applications/${s.appId}/users/u1/subscription/cancel`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SUB_008");
  });
});

describe("the user's own invoices and usage", () => {
  it("lists every invoice of the user, wallet top-ups included", async () => {
    const s = await seed({ subscriptionId: "sub_paid", planId: "pro" });
    const log = { warn: () => undefined, debug: () => undefined };
    const base = {
      object: "invoice",
      currency: "eur",
      amount_due: 1000,
      amount_paid: 1000,
      amount_remaining: 0,
      period_start: T0,
      period_end: T0,
      customer: "cus_u1",
      metadata: {},
    };
    await cacheStripeInvoice(
      {
        ...base,
        id: "in_sub",
        status: "paid",
        created: T0,
        billing_reason: "subscription_cycle",
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_paid", metadata: { applicationId: s.appId } },
        },
      } as unknown as Stripe.Invoice,
      T0,
      log,
    );
    await cacheStripeInvoice(
      {
        ...base,
        id: "in_wallet",
        status: "paid",
        created: T0 + 1,
        billing_reason: "manual",
        customer: null,
        metadata: { purpose: "wallet_topup", userId: "u1" },
        parent: null,
      } as unknown as Stripe.Invoice,
      T0 + 1,
      log,
    );
    vi.spyOn(auth.api, "getSession").mockResolvedValue(makeUserSession("u1") as never);

    const res = await handle.app.inject({ method: "GET", url: "/api/user/billing/invoices" });
    expect(res.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(["in_wallet", "in_sub"]);
    expect(await db.select().from(stripeInvoices)).toHaveLength(2);
  });

  it("refuses the usage of an application the user does not use", async () => {
    const s = await seed({ subscriptionId: null, planId: "free" });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(makeUserSession("u2") as never);
    const res = await handle.app.inject({
      method: "GET",
      url: `/api/user/billing/usage?applicationId=${s.appId}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
