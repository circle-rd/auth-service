import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

const { stripeHolder, calls } = vi.hoisted(() => {
  const calls = {
    productsCreate: [] as unknown[],
    pricesCreate: [] as Record<string, unknown>[],
    customersCreate: [] as unknown[],
    subsCreate: [] as { params: unknown; options: unknown }[],
    subsRetrieve: [] as string[],
    subsUpdate: [] as [string, Record<string, unknown>][],
    checkoutCreate: [] as Record<string, unknown>[],
    checkoutOptions: [] as Record<string, unknown>[],
    portalCreate: [] as Record<string, unknown>[],
  };
  const stripe = {
    products: {
      create: vi.fn(async (p: unknown) => ({
        id: `prod_${calls.productsCreate.push(p)}`,
      })),
      update: vi.fn(async (id: string) => ({ id })),
    },
    prices: {
      create: vi.fn(async (p: Record<string, unknown>) => ({
        id: `price_${calls.pricesCreate.push(p)}`,
      })),
      update: vi.fn(async () => ({})),
    },
    customers: {
      create: vi.fn(async (p: unknown) => ({
        id: `cus_${calls.customersCreate.push(p)}`,
      })),
    },
    subscriptions: {
      create: vi.fn(async (params: unknown, options: unknown) => {
        calls.subsCreate.push({ params, options });
        return { id: "sub_new", status: "active" };
      }),
      retrieve: vi.fn(async (id: string) => {
        calls.subsRetrieve.push(id);
        return { id, items: { data: [{ id: "si_1", price: { id: "price_old" } }] } };
      }),
      update: vi.fn(async (id: string, params: Record<string, unknown>) => {
        calls.subsUpdate.push([id, params]);
        return { id, status: "active" };
      }),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (p: Record<string, unknown>, options: unknown) => {
          calls.checkoutCreate.push(p);
          calls.checkoutOptions.push(options as Record<string, unknown>);
          return { id: "cs_1", url: "https://checkout.test" };
        }),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async (p: Record<string, unknown>) => {
          calls.portalCreate.push(p);
          return { url: "https://portal.test" };
        }),
      },
    },
  };
  return { stripeHolder: { stripe }, calls };
});

vi.mock("../services/stripe.js", () => ({
  get stripe() {
    return stripeHolder.stripe;
  },
}));

import {
  cancelStripeSubscription,
  createBillingPortalUrl,
  createSubscriptionCheckout,
  syncStripeSubscription,
} from "../services/billing/subscriptions.js";

beforeEach(async () => {
  await cleanDb();
  calls.productsCreate.length = 0;
  calls.pricesCreate.length = 0;
  calls.customersCreate.length = 0;
  calls.subsCreate.length = 0;
  calls.subsRetrieve.length = 0;
  calls.subsUpdate.length = 0;
  calls.checkoutCreate.length = 0;
  calls.checkoutOptions.length = 0;
  calls.portalCreate.length = 0;
});

async function seed() {
  await db.insert(user).values({
    id: "u1",
    name: "u1",
    email: "u1@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [app] = await db
    .insert(applications)
    .values({ name: "App", slug: "app", isActive: true })
    .returning();
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app!.id, name: "free", isDefault: true })
    .returning();
  await db.insert(userSubscriptions).values({
    userId: "u1",
    applicationId: app!.id,
    planId: plan!.id,
  });
  return { app: app!, plan: plan! };
}

describe("syncStripeSubscription", () => {
  it("creates a 0 EUR Price for the free plan and links the subscription", async () => {
    const { app, plan } = await seed();
    await syncStripeSubscription({
      userId: "u1",
      applicationId: app.id,
      planId: plan.id,
    });

    const [row] = await db
      .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, "u1"));
    expect(row?.stripeSubscriptionId).toBe("sub_new");

    const [price] = await db
      .select({
        amount: subscriptionPlanPrices.amount,
        stripePriceId: subscriptionPlanPrices.stripePriceId,
      })
      .from(subscriptionPlanPrices)
      .where(eq(subscriptionPlanPrices.planId, plan.id));
    expect(price?.amount).toBe("0");
    expect(price?.stripePriceId).toMatch(/^price_/);

    expect(calls.subsCreate).toHaveLength(1);
    const created = calls.subsCreate[0]!.params as unknown as {
      customer: string;
      items: { price: string }[];
      metadata: Record<string, string>;
    };
    expect(created.customer).toMatch(/^cus_/);
    expect(created.items[0]?.price).toBe(price?.stripePriceId);
    expect(created.metadata).toEqual({
      userId: "u1",
      applicationId: app.id,
      planId: plan.id,
    });
  });

  it("updates the subscription item when the plan's price changes", async () => {
    const { app, plan } = await seed();
    await db
      .update(userSubscriptions)
      .set({ stripeSubscriptionId: "sub_old" })
      .where(eq(userSubscriptions.userId, "u1"));
    await db.insert(subscriptionPlanPrices).values({
      planId: plan.id,
      name: "Premium",
      amount: "1500",
      interval: "month",
      billingType: "fixed",
      stripePriceId: "price_new",
    });

    await syncStripeSubscription({
      userId: "u1",
      applicationId: app.id,
      planId: plan.id,
    });
    expect(calls.subsRetrieve).toContain("sub_old");
    expect(calls.subsUpdate[0]?.[0]).toBe("sub_old");
    expect(calls.subsUpdate[0]?.[1]).toMatchObject({
      items: [{ id: "si_1", price: "price_new" }],
    });
  });
});

describe("subscription checkout and portal", () => {
  it("opens a Checkout in subscription mode for a plan with a recurring price", async () => {
    const { app, plan } = await seed();
    await db.insert(subscriptionPlanPrices).values({
      planId: plan.id,
      name: "Monthly",
      amount: "1500",
      interval: "month",
      billingType: "fixed",
      stripePriceId: "price_month",
    });
    expect(
      await createSubscriptionCheckout({
        userId: "u1",
        applicationId: app.id,
        planId: plan.id,
      }),
    ).toEqual({ url: "https://checkout.test" });
    expect(calls.checkoutCreate[0]).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_month", quantity: 1 }],
    });
    expect(calls.checkoutOptions[0]).toMatchObject({
      idempotencyKey: expect.stringMatching(
        new RegExp(`^billing:checkout:u1:${app.id}:${plan.id}:\\d+$`),
      ),
    });
  });

  it("refuses a plan without a recurring price", async () => {
    const { app, plan } = await seed();
    await expect(
      createSubscriptionCheckout({
        userId: "u1",
        applicationId: app.id,
        planId: plan.id,
      }),
    ).rejects.toMatchObject({ code: "BIL_002" });
  });

  it("opens the Billing Portal on the user's customer", async () => {
    await db.insert(user).values({
      id: "u2",
      name: "u2",
      email: "u2@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await createBillingPortalUrl({ userId: "u2" })).toEqual({
      url: "https://portal.test",
    });
    expect(calls.portalCreate[0]?.customer).toMatch(/^cus_/);
  });
});

describe("cancelStripeSubscription", () => {
  it("cancels at period end when the row is linked", async () => {
    const { app } = await seed();
    await db
      .update(userSubscriptions)
      .set({ stripeSubscriptionId: "sub_old" })
      .where(eq(userSubscriptions.userId, "u1"));
    await cancelStripeSubscription({ userId: "u1", applicationId: app.id });
    expect(calls.subsUpdate[0]).toEqual([
      "sub_old",
      { cancel_at_period_end: true },
    ]);
  });

  it("does nothing without a linked subscription", async () => {
    const { app } = await seed();
    await cancelStripeSubscription({ userId: "u1", applicationId: app.id });
    expect(calls.subsUpdate).toHaveLength(0);
  });
});
