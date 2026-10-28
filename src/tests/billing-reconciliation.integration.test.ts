import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  billingCustomers,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

const { holder, state } = vi.hoisted(() => {
  const state = {
    customers: new Set<string>(),
    products: new Map<string, Record<string, unknown>>(),
    prices: new Map<string, Record<string, unknown>>(),
    meters: new Map<string, Record<string, unknown>>(),
    subscriptions: new Map<string, Record<string, unknown>>(),
    created: { products: 0, prices: 0, customers: 0, subscriptions: 0 },
    cancelled: [] as string[],
  };
  const stripe = {
    customers: {
      retrieve: async (id: string) => {
        if (!state.customers.has(id)) throw { code: "resource_missing" };
        return { id };
      },
      create: async () => {
        state.created.customers += 1;
        const id = `cus_${state.created.customers}`;
        state.customers.add(id);
        return { id };
      },
      list: async () => ({
        data: [...state.customers].map((id) => ({ id })),
        has_more: false,
      }),
    },
    products: {
      retrieve: async (id: string) => {
        const product = state.products.get(id);
        if (!product) throw { code: "resource_missing" };
        return product;
      },
      create: async (params: Record<string, unknown>) => {
        state.created.products += 1;
        const id = `prod_${state.created.products}`;
        state.products.set(id, {
          id,
          active: true,
          name: params.name,
          description: params.description ?? null,
          metadata: params.metadata ?? {},
        });
        return state.products.get(id);
      },
      update: async (id: string, params: Record<string, unknown>) => {
        const product = state.products.get(id);
        if (product) state.products.set(id, { ...product, ...params });
        return { id };
      },
    },
    prices: {
      retrieve: async (id: string) => {
        const price = state.prices.get(id);
        if (!price) throw { code: "resource_missing" };
        return price;
      },
      create: async (params: Record<string, unknown>) => {
        state.created.prices += 1;
        const id = `price_${state.created.prices}`;
        const recurring = params.recurring as { meter?: string } | undefined;
        state.prices.set(id, {
          id,
          active: true,
          product: params.product,
          nickname: params.nickname,
          ...(recurring?.meter ? { meter: recurring.meter } : {}),
        });
        return state.prices.get(id);
      },
      update: async (id: string, params: Record<string, unknown>) => {
        const price = state.prices.get(id);
        if (price) state.prices.set(id, { ...price, ...params });
        return { id };
      },
    },
    billing: {
      meters: {
        retrieve: async (id: string) => {
          const meter = state.meters.get(id);
          if (!meter) throw { code: "resource_missing" };
          return meter;
        },
        create: async () => {
          const id = `meter_${state.meters.size + 1}`;
          state.meters.set(id, { id, status: "active" });
          return state.meters.get(id);
        },
        deactivate: async (id: string) => {
          state.meters.set(id, { id, status: "inactive" });
          return state.meters.get(id);
        },
      },
    },
    subscriptions: {
      list: async () => ({
        data: [...state.subscriptions.values()],
        has_more: false,
      }),
      retrieve: async (id: string) => {
        const subscription = state.subscriptions.get(id);
        if (!subscription) throw { code: "resource_missing" };
        return subscription;
      },
      create: async (params: Record<string, unknown>) => {
        state.created.subscriptions += 1;
        const id = `sub_${state.created.subscriptions}`;
        state.subscriptions.set(id, {
          id,
          object: "subscription",
          customer: params.customer,
          status: "active",
          items: {
            data: [
              {
                id: `si_${id}`,
                price: {
                  id: (params.items as { price: string }[])[0]!.price,
                  product: "prod_1",
                },
                current_period_start: 1_793_000_000,
                current_period_end: 1_795_592_000,
              },
            ],
          },
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: params.metadata ?? {},
        });
        return state.subscriptions.get(id);
      },
      update: async (id: string, params: Record<string, unknown>) => {
        const subscription = state.subscriptions.get(id);
        if (subscription) state.subscriptions.set(id, { ...subscription, ...params });
        return { id };
      },
      cancel: async (id: string) => {
        state.cancelled.push(id);
        const subscription = state.subscriptions.get(id);
        if (subscription) {
          state.subscriptions.set(id, {
            ...subscription,
            status: "canceled",
            canceled_at: 1_793_100_000,
          });
        }
        return { id };
      },
    },
  };
  const holder: { stripe: unknown } = { stripe };
  return { holder, state };
});

vi.mock("../services/stripe.js", () => ({
  get stripe() {
    return holder.stripe;
  },
  isStripeConfigured: () => true,
}));

import { reconcileBilling } from "../services/billing/reconciliation.js";

beforeEach(async () => {
  await cleanDb();
  state.customers.clear();
  state.products.clear();
  state.prices.clear();
  state.meters.clear();
  state.subscriptions.clear();
  state.created = { products: 0, prices: 0, customers: 0, subscriptions: 0 };
  state.cancelled.length = 0;
});

async function seedUser(id = "u1") {
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedApp(slug = "app") {
  const [app] = await db
    .insert(applications)
    .values({ name: "App", slug, isActive: true })
    .returning();
  return app!;
}

function stripeSubscription(
  id: string,
  customer: string,
  priceId: string,
  metadata: Record<string, string>,
  status = "active",
) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    items: {
      data: [
        {
          id: `si_${id}`,
          price: { id: priceId, product: "prod_1" },
          current_period_start: 1_793_000_000,
          current_period_end: 1_795_592_000,
        },
      ],
    },
    cancel_at_period_end: false,
    canceled_at: null,
    metadata,
  } as unknown as Record<string, unknown>;
}

describe("reconcileBilling", () => {
  it("creates the customer, product, price and subscription a fresh assignment needs", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: app.id, name: "free", isDefault: true })
      .returning();
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
    });

    const report = await reconcileBilling();

    expect(report.issues.map((i) => i.kind)).toEqual([
      "customer_missing",
      "product_missing",
      "subscription_unlinked",
    ]);
    expect(report.issues.every((i) => i.action !== "reported")).toBe(true);
    expect(report.summary).toMatchObject({
      customersCreated: 1,
      productsCreated: 1,
      subscriptionsLinked: 1,
    });

    const [row] = await db
      .select({
        stripeSubscriptionId: userSubscriptions.stripeSubscriptionId,
        stripeStatus: userSubscriptions.stripeStatus,
      })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, "u1"));
    expect(row?.stripeSubscriptionId).toMatch(/^sub_/);
    expect(row?.stripeStatus).toBe("active");
  });

  it("reports drift without writing in check mode, then repairs the price", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_old", {
      id: "price_old",
      active: false,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_old",
    });

    const checked = await reconcileBilling({ mode: "check" });
    expect(checked.issues).toContainEqual(
      expect.objectContaining({ kind: "price_unusable", action: "reported" }),
    );
    expect(state.created.prices).toBe(0);

    const repaired = await reconcileBilling();
    expect(repaired.issues).toContainEqual(
      expect.objectContaining({ kind: "price_unusable", action: "relinked" }),
    );
    expect(state.created.prices).toBe(1);
    const [price] = await db
      .select({ stripePriceId: subscriptionPlanPrices.stripePriceId })
      .from(subscriptionPlanPrices);
    expect(price?.stripePriceId).toBe("price_1");
  });

  it("re-applies a subscription state that drifted from Stripe", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.customers.add("cus_1");
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      isActive: true,
      stripeSubscriptionId: "sub_1",
      stripeStatus: "active",
    });
    state.subscriptions.set(
      "sub_1",
      stripeSubscription(
        "sub_1",
        "cus_1",
        "price_1",
        { userId: "u1", applicationId: app.id },
        "past_due",
      ),
    );

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "subscription_state" }),
    );
    const [row] = await db
      .select({
        isActive: userSubscriptions.isActive,
        stripeStatus: userSubscriptions.stripeStatus,
      })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, "u1"));
    expect(row).toEqual({ isActive: false, stripeStatus: "past_due" });
  });

  it("adopts an existing subscription instead of creating a second one", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: app.id, name: "free", isDefault: true })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — Free",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Free",
    });
    await db
      .update(subscriptionPlans)
      .set({ stripeProductId: "prod_1" })
      .where(eq(subscriptionPlans.id, plan!.id));
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Free",
      amount: "0",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
    });
    state.subscriptions.set(
      "sub_existing",
      stripeSubscription("sub_existing", "cus_1", "price_1", {
        userId: "u1",
        applicationId: app.id,
      }),
    );

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: "subscription_unlinked",
        action: "relinked",
      }),
    );
    expect(state.created.subscriptions).toBe(0);
    const [row] = await db
      .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
      .from(userSubscriptions);
    expect(row?.stripeSubscriptionId).toBe("sub_existing");
  });

  it("reports a superseded subscription and only cancels it on request", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    const metadata = { userId: "u1", applicationId: app.id };
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      isActive: true,
      stripeSubscriptionId: "sub_new",
      stripeStatus: "active",
      currentPeriodStart: new Date(1_793_000_000 * 1000),
      currentPeriodEnd: new Date(1_795_592_000 * 1000),
    });
    state.subscriptions.set(
      "sub_new",
      stripeSubscription("sub_new", "cus_1", "price_1", metadata),
    );
    state.subscriptions.set(
      "sub_old",
      stripeSubscription("sub_old", "cus_1", "price_1", metadata),
    );

    const checked = await reconcileBilling({ mode: "check" });
    expect(checked.issues).toContainEqual(
      expect.objectContaining({ kind: "superseded_subscription" }),
    );
    expect(state.cancelled).toEqual([]);

    await reconcileBilling();
    expect(state.cancelled).toEqual([]);

    await reconcileBilling({ cancelSuperseded: true });
    expect(state.cancelled).toEqual(["sub_old"]);
  });

  it("returns an empty report when Stripe is not configured", async () => {
    const configured = holder.stripe;
    holder.stripe = null;
    try {
      const report = await reconcileBilling({ mode: "check" });
      expect(report.issues).toEqual([]);
      expect(report.pendingMeterEvents).toBe(0);
    } finally {
      holder.stripe = configured;
    }
  });

  it("reports a deleted customer and does not try to repair its subscriptions", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: app.id, name: "free", isDefault: true })
      .returning();
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
    });
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_deleted",
    });

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: "customer_deleted",
        action: "reported",
      }),
    );
    expect(state.created.subscriptions).toBe(0);
  });

  it("replaces an inactive product and corrects product metadata", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        description: "Pro plan",
        stripeProductId: "prod_old",
      })
      .returning();
    state.products.set("prod_old", {
      id: "prod_old",
      active: false,
      name: "stale",
      description: null,
      metadata: {},
    });

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "product_unusable", action: "relinked" }),
    );
    const [row] = await db
      .select({ stripeProductId: subscriptionPlans.stripeProductId })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, plan!.id));
    expect(row?.stripeProductId).toBe("prod_1");

    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "stale name",
      description: null,
      metadata: {},
    });
    const updated = await reconcileBilling();
    expect(updated.issues).toContainEqual(
      expect.objectContaining({ kind: "product_metadata", action: "updated" }),
    );
    expect(state.products.get("prod_1")).toMatchObject({
      name: "App — pro",
      description: "Pro plan",
      metadata: { applicationId: app.id },
    });
  });

  it("creates a missing price and repairs a price on the wrong product and nickname", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    await db.insert(subscriptionPlanPrices).values([
      {
        planId: plan!.id,
        name: "Monthly",
        amount: "1000",
        currency: "eur",
        interval: "month",
      },
      {
        planId: plan!.id,
        name: "Yearly",
        amount: "10000",
        currency: "eur",
        interval: "year",
        stripePriceId: "price_wrong_product",
      },
    ]);
    state.prices.set("price_wrong_product", {
      id: "price_wrong_product",
      active: true,
      product: "prod_other",
      nickname: "Yearly",
    });

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "price_missing", action: "created" }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "price_metadata", action: "relinked" }),
    );
    const rows = await db
      .select({
        name: subscriptionPlanPrices.name,
        stripePriceId: subscriptionPlanPrices.stripePriceId,
      })
      .from(subscriptionPlanPrices)
      .orderBy(subscriptionPlanPrices.name);
    expect(rows.map((r) => r.name)).toEqual(["Monthly", "Yearly"]);
    expect(rows.every((r) => r.stripePriceId?.startsWith("price_"))).toBe(true);
    expect(rows.find((r) => r.name === "Yearly")?.stripePriceId).not.toBe(
      "price_wrong_product",
    );
  });

  it("repairs a metered price whose meter is missing or inactive", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_metered", {
      id: "price_metered",
      active: true,
      product: "prod_1",
      nickname: "Calls",
      meter: "meter_old",
    });
    state.meters.set("meter_old", { id: "meter_old", status: "inactive" });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Calls",
      amount: "10",
      currency: "eur",
      interval: "month",
      billingType: "metered",
      featureKey: "api.calls",
      unit: "call",
      usageLimit: 10,
      stripePriceId: "price_metered",
      stripeMeterId: "meter_old",
    });

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "meter_unusable", action: "relinked" }),
    );
    const [row] = await db
      .select({
        stripePriceId: subscriptionPlanPrices.stripePriceId,
        stripeMeterId: subscriptionPlanPrices.stripeMeterId,
      })
      .from(subscriptionPlanPrices);
    expect(row?.stripePriceId).not.toBe("price_metered");
    expect(row?.stripeMeterId).not.toBe("meter_old");
  });

  it("relinks a subscription whose Stripe object was deleted", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      stripeSubscriptionId: "sub_gone",
      stripeStatus: "active",
      isActive: true,
    });

    const checked = await reconcileBilling();
    expect(checked.issues).toContainEqual(
      expect.objectContaining({
        kind: "subscription_missing",
        action: "reported",
      }),
    );
    const [unchanged] = await db
      .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
      .from(userSubscriptions);
    expect(unchanged?.stripeSubscriptionId).toBe("sub_gone");

    const repaired = await reconcileBilling({ recreateMissing: true });
    expect(repaired.issues).toContainEqual(
      expect.objectContaining({
        kind: "subscription_missing",
        action: "relinked",
      }),
    );
    const [row] = await db
      .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
      .from(userSubscriptions);
    expect(row?.stripeSubscriptionId).toMatch(/^sub_/);
    expect(row?.stripeSubscriptionId).not.toBe("sub_gone");
  });

  it("never recreates a subscription for an inactive row", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      stripeSubscriptionId: "sub_gone",
      stripeStatus: "canceled",
      isActive: false,
    });

    const report = await reconcileBilling({ recreateMissing: true });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: "subscription_missing",
        action: "reported",
      }),
    );
    expect(state.created.subscriptions).toBe(0);
    const [row] = await db
      .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
      .from(userSubscriptions);
    expect(row?.stripeSubscriptionId).toBe("sub_gone");
  });

  it("adopts a past_due subscription instead of creating a second one", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      isActive: true,
    });
    state.subscriptions.set(
      "sub_due",
      stripeSubscription(
        "sub_due",
        "cus_1",
        "price_1",
        { userId: "u1", applicationId: app.id },
        "past_due",
      ),
    );

    const report = await reconcileBilling({ cancelSuperseded: true });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: "subscription_unlinked",
        action: "relinked",
      }),
    );
    expect(state.created.subscriptions).toBe(0);
    expect(state.cancelled).toEqual([]);
    const [row] = await db
      .select({ stripeSubscriptionId: userSubscriptions.stripeSubscriptionId })
      .from(userSubscriptions);
    expect(row?.stripeSubscriptionId).toBe("sub_due");
  });

  it("adopts the plan Stripe bills when it differs from the local row", async () => {
    await seedUser();
    const app = await seedApp();
    const [planA] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "basic",
        stripeProductId: "prod_1",
      })
      .returning();
    const [planB] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "premium",
        stripeProductId: "prod_1",
      })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — basic",
      description: null,
      metadata: { applicationId: app.id },
    });
    for (const [id, planId, name] of [
      ["price_a", planA!.id, "Basic"],
      ["price_b", planB!.id, "Premium"],
    ] as const) {
      state.prices.set(id, {
        id,
        active: true,
        product: "prod_1",
        nickname: name,
      });
      await db.insert(subscriptionPlanPrices).values({
        planId,
        name,
        amount: "1000",
        currency: "eur",
        interval: "month",
        stripePriceId: id,
      });
    }
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: planA!.id,
      stripeSubscriptionId: "sub_1",
      stripeStatus: "active",
      isActive: true,
      currentPeriodStart: new Date(1_793_000_000 * 1000),
      currentPeriodEnd: new Date(1_795_592_000 * 1000),
    });
    state.subscriptions.set(
      "sub_1",
      stripeSubscription("sub_1", "cus_1", "price_b", {
        userId: "u1",
        applicationId: app.id,
      }),
    );

    await reconcileBilling();

    const [row] = await db
      .select({ planId: userSubscriptions.planId })
      .from(userSubscriptions);
    expect(row?.planId).toBe(planB!.id);
  });

  it("keeps the drift reported when no subscription can be created", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      isActive: true,
    });

    const report = await reconcileBilling();

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: "subscription_unlinked",
        action: "reported",
      }),
    );
    expect(report.summary.subscriptionsLinked).toBe(0);
    expect(state.created.subscriptions).toBe(0);
  });

  it("does not cancel a superseded subscription without a live replacement", async () => {
    await seedUser();
    const app = await seedApp();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app.id,
        name: "pro",
        stripeProductId: "prod_1",
      })
      .returning();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.products.set("prod_1", {
      id: "prod_1",
      active: true,
      name: "App — pro",
      description: null,
      metadata: { applicationId: app.id },
    });
    state.prices.set("price_1", {
      id: "price_1",
      active: true,
      product: "prod_1",
      nickname: "Monthly",
    });
    await db.insert(subscriptionPlanPrices).values({
      planId: plan!.id,
      name: "Monthly",
      amount: "1000",
      currency: "eur",
      interval: "month",
      stripePriceId: "price_1",
    });
    const metadata = { userId: "u1", applicationId: app.id };
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: app.id,
      planId: plan!.id,
      isActive: true,
      stripeSubscriptionId: "sub_missing",
      stripeStatus: "active",
    });
    state.subscriptions.set(
      "sub_old",
      stripeSubscription("sub_old", "cus_1", "price_1", metadata),
    );

    const report = await reconcileBilling({ cancelSuperseded: true });

    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "superseded_subscription" }),
    );
    expect(state.cancelled).toEqual([]);
  });

  it("reports an orphan subscription but never cancels it", async () => {
    await seedUser();
    const app = await seedApp();
    state.customers.add("cus_1");
    await db.insert(billingCustomers).values({
      ownerType: "user",
      ownerId: "u1",
      stripeCustomerId: "cus_1",
    });
    state.subscriptions.set(
      "sub_orphan",
      stripeSubscription("sub_orphan", "cus_1", "price_1", {
        userId: "u1",
        applicationId: app.id,
      }),
    );

    const report = await reconcileBilling({ cancelSuperseded: true });

    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: "orphan_subscription" }),
    );
    expect(state.cancelled).toEqual([]);
  });
});
