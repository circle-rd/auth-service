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
import { createTestApp } from "./helpers/app.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";
import { plansRoutes } from "../routes/admin/plans.js";
import { planPricesRoutes } from "../routes/admin/plan-prices.js";
import {
  archiveApplicationCatalogue,
  loadApplicationCatalogue,
  provisionPlanProductBestEffort,
  updateApplicationProducts,
} from "../services/billing/catalog.js";

const { stripeHolder, calls } = vi.hoisted(() => {
  const calls = {
    productsCreate: [] as unknown[],
    productsUpdate: [] as [string, unknown][],
    pricesCreate: [] as Record<string, unknown>[],
    pricesUpdate: [] as [string, unknown][],
    metersCreate: [] as unknown[],
    metersDeactivate: [] as string[],
  };
  const stripe = {
    products: {
      create: vi.fn(async (p: unknown) => ({
        id: `prod_${calls.productsCreate.push(p)}`,
      })),
      update: vi.fn(async (id: string, p: unknown) => {
        calls.productsUpdate.push([id, p]);
        return { id };
      }),
    },
    prices: {
      create: vi.fn(async (p: Record<string, unknown>) => ({
        id: `price_${calls.pricesCreate.push(p)}`,
      })),
      update: vi.fn(async (id: string, p: unknown) => {
        calls.pricesUpdate.push([id, p]);
        return { id };
      }),
    },
    billing: {
      meters: {
        create: vi.fn(async (p: unknown) => ({
          id: `meter_${calls.metersCreate.push(p)}`,
        })),
        retrieve: vi.fn(async (id: string) => ({ id, status: "active" })),
        deactivate: vi.fn(async (id: string) => {
          calls.metersDeactivate.push(id);
          return { id };
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
vi.mock("../services/event-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EventBusModule>();
  return { ...actual, publishEvent: vi.fn() };
});

const app = createTestApp();

beforeAll(async () => {
  await app.register(plansRoutes, { prefix: "/api/admin" });
  await app.register(planPricesRoutes, { prefix: "/api/admin" });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  calls.productsCreate.length = 0;
  calls.productsUpdate.length = 0;
  calls.pricesCreate.length = 0;
  calls.pricesUpdate.length = 0;
  calls.metersCreate.length = 0;
  calls.metersDeactivate.length = 0;
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession("sa-1") as never,
  );
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedApp(slug = "app") {
  const [a] = await db
    .insert(applications)
    .values({ name: "App", slug, isActive: true })
    .returning();
  return a!;
}

async function createPlan(appId: string, name = "pro") {
  const res = await app.inject({
    method: "POST",
    url: `/api/admin/applications/${appId}/plans`,
    payload: { name, description: `${name} plan` },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ plan: { id: string; stripeProductId: string | null } }>()
    .plan;
}

async function createPrice(appId: string, planId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/admin/applications/${appId}/plans/${planId}/prices`,
    payload,
  });
}

const metered = {
  name: "API calls",
  amount: 5,
  currency: "usd",
  interval: "month",
  billingType: "metered",
  featureKey: "api.calls",
  unit: "call",
  usageLimit: 100,
};

const fixed = {
  name: "Monthly",
  amount: 1000,
  currency: "usd",
  interval: "month",
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("plan product provisioning", () => {
  it("creates and stores the Stripe product of a new plan", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    expect(plan.stripeProductId).toBe("prod_1");
    expect(calls.productsCreate).toHaveLength(1);
    expect(calls.productsCreate[0]).toMatchObject({
      metadata: { applicationId: a.id },
    });
  });

  it("renames the Stripe product when the plan is renamed", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/applications/${a.id}/plans/${plan.id}`,
      payload: { name: "Pro Plus" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.productsUpdate).toEqual([
      ["prod_1", expect.objectContaining({ name: "App — Pro Plus" })],
    ]);
  });
});

describe("price and meter provisioning", () => {
  it("creates a meter and a metered price, then reuses the meter for another plan of the same app", async () => {
    const a = await seedApp();
    const planA = await createPlan(a.id, "a");
    const resA = await createPrice(a.id, planA.id, metered);
    expect(resA.statusCode).toBe(201);
    const priceA = resA.json<{ price: Record<string, unknown> }>().price;
    expect(priceA).toMatchObject({
      billingType: "metered",
      featureKey: "api.calls",
      unit: "call",
      usageLimit: 100,
      stripeMeterId: "meter_1",
      stripePriceId: "price_1",
    });
    expect(calls.metersCreate).toHaveLength(1);
    expect(calls.pricesCreate[0]).toMatchObject({
      recurring: { interval: "month", usage_type: "metered", meter: "meter_1" },
    });

    const planB = await createPlan(a.id, "b");
    const resB = await createPrice(a.id, planB.id, metered);
    expect(resB.statusCode).toBe(201);
    expect(resB.json<{ price: { stripeMeterId: string } }>().price.stripeMeterId).toBe(
      "meter_1",
    );
    // The second plan reuses the shared meter instead of creating a new one.
    expect(calls.metersCreate).toHaveLength(1);
  });

  it("rejects a duplicate metered feature key on the same plan", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    expect((await createPrice(a.id, plan.id, metered)).statusCode).toBe(201);
    const dupe = await createPrice(a.id, plan.id, metered);
    expect(dupe.statusCode).toBe(400);
    expect(dupe.json<{ error: { code: string } }>().error.code).toBe("BIL_002");
  });

  it("rejects a fixed price carrying metered fields", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    const res = await createPrice(a.id, plan.id, {
      ...fixed,
      featureKey: "api.calls",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("price update", () => {
  it("renames the Stripe price on PATCH", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    const price = (
      await createPrice(a.id, plan.id, fixed)
    ).json<{ price: { id: string } }>().price;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/applications/${a.id}/plans/${plan.id}/prices/${price.id}`,
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ price: { name: string } }>().price.name).toBe("Renamed");
    expect(calls.pricesUpdate).toEqual([
      ["price_1", expect.objectContaining({ nickname: "Renamed" })],
    ]);
  });

  it("rejects unit on a fixed price", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    const price = (
      await createPrice(a.id, plan.id, fixed)
    ).json<{ price: { id: string } }>().price;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/applications/${a.id}/plans/${plan.id}/prices/${price.id}`,
      payload: { unit: "call" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("price deletion and meter lifecycle", () => {
  it("deactivates the meter when its last price is deleted", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    const price = (
      await createPrice(a.id, plan.id, metered)
    ).json<{ price: { id: string } }>().price;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/applications/${a.id}/plans/${plan.id}/prices/${price.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(calls.metersDeactivate).toEqual(["meter_1"]);
    expect(calls.pricesUpdate).toContainEqual([
      "price_1",
      expect.objectContaining({ active: false }),
    ]);
  });

  it("keeps the meter when another plan still bills the feature", async () => {
    const a = await seedApp();
    const planA = await createPlan(a.id, "a");
    const planB = await createPlan(a.id, "b");
    const priceA = (
      await createPrice(a.id, planA.id, metered)
    ).json<{ price: { id: string } }>().price;
    await createPrice(a.id, planB.id, metered);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/applications/${a.id}/plans/${planA.id}/prices/${priceA.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(calls.metersDeactivate).toHaveLength(0);
  });
});

describe("plan deletion", () => {
  async function seedUser(id: string) {
    await db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("archives the Stripe objects and removes inactive subscriptions", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    await createPrice(a.id, plan.id, fixed);
    await seedUser("u1");
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: a.id,
      planId: plan.id,
      isActive: false,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/applications/${a.id}/plans/${plan.id}`,
    });
    expect(res.statusCode).toBe(204);

    expect(calls.productsUpdate).toContainEqual([
      "prod_1",
      expect.objectContaining({ active: false }),
    ]);
    expect(calls.pricesUpdate).toContainEqual([
      "price_1",
      expect.objectContaining({ active: false }),
    ]);
    const remaining = await db
      .select({ id: userSubscriptions.id })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.planId, plan.id));
    expect(remaining).toHaveLength(0);
  });

  it("refuses to delete a plan with an active subscriber", async () => {
    const a = await seedApp();
    const plan = await createPlan(a.id, "pro");
    await seedUser("u1");
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: a.id,
      planId: plan.id,
      isActive: true,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/applications/${a.id}/plans/${plan.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SUB_003");
    const [still] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, plan.id));
    expect(still?.id).toBe(plan.id);
  });
});

describe("application catalogue lifecycle", () => {
  async function seedAppWithPlan(slug = "app") {
    const [a] = await db
      .insert(applications)
      .values({ name: "App", slug, isActive: true })
      .returning();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: a!.id, name: "free", isDefault: true })
      .returning();
    return { app: a!, plan: plan! };
  }

  it("provisions the default plan's product and links it", async () => {
    const { app: a, plan } = await seedAppWithPlan();
    await provisionPlanProductBestEffort({
      planId: plan.id,
      applicationId: a.id,
      appName: "App",
      planName: "free",
      description: null,
    });
    const [row] = await db
      .select({ stripeProductId: subscriptionPlans.stripeProductId })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, plan.id));
    expect(row?.stripeProductId).toMatch(/^prod_/);
    expect(calls.productsCreate).toHaveLength(1);
  });

  it("swallows a Stripe failure so it cannot break application creation", async () => {
    const { app: a, plan } = await seedAppWithPlan();
    stripeHolder.stripe.products.create.mockRejectedValueOnce(new Error("down"));
    await expect(
      provisionPlanProductBestEffort({
        planId: plan.id,
        applicationId: a.id,
        appName: "App",
        planName: "free",
        description: null,
      }),
    ).resolves.toBeUndefined();
    const [row] = await db
      .select({ stripeProductId: subscriptionPlans.stripeProductId })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, plan.id));
    expect(row?.stripeProductId).toBeNull();
  });

  it("renames the products of an application's plans", async () => {
    const { app: a } = await seedAppWithPlan();
    await db
      .update(subscriptionPlans)
      .set({ stripeProductId: "prod_old" })
      .where(eq(subscriptionPlans.applicationId, a.id));
    await updateApplicationProducts({ applicationId: a.id, appName: "Renamed" });
    expect(calls.productsUpdate).toEqual([
      ["prod_old", expect.objectContaining({ name: "Renamed — free" })],
    ]);
  });

  it("loads and archives an application's catalogue", async () => {
    const { app: a, plan } = await seedAppWithPlan();
    await db
      .update(subscriptionPlans)
      .set({ stripeProductId: "prod_a" })
      .where(eq(subscriptionPlans.id, plan.id));
    await db.insert(subscriptionPlanPrices).values([
      { planId: plan.id, name: "Monthly", amount: "1500", stripePriceId: "price_a" },
      {
        planId: plan.id,
        name: "Calls",
        amount: "10",
        billingType: "metered",
        featureKey: "api.calls",
        unit: "call",
        usageLimit: 1000,
        stripePriceId: "price_b",
        stripeMeterId: "meter_a",
      },
    ]);

    const catalogue = await loadApplicationCatalogue(a.id);
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]?.stripeProductId).toBe("prod_a");
    expect(catalogue[0]?.prices.map((p) => p.stripePriceId).sort()).toEqual([
      "price_a",
      "price_b",
    ]);

    await archiveApplicationCatalogue(catalogue);
    expect(calls.pricesUpdate.map((c) => c[0]).sort()).toEqual([
      "price_a",
      "price_b",
    ]);
    expect(calls.productsUpdate).toEqual([
      ["prod_a", { active: false }],
    ]);
    expect(calls.metersDeactivate).toEqual(["meter_a"]);
  });
});

describe("plan inputs are strict", () => {
  it("refuses a Stripe Product id supplied by the caller", async () => {
    const a = await seedApp("strict-product");
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/applications/${a.id}/plans`,
      payload: { name: "pro", stripeProductId: "prod_someone_elses" },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.productsCreate).toHaveLength(0);
  });

  it("refuses a metered feature declared in the features JSON", async () => {
    const a = await seedApp("strict-features");
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/applications/${a.id}/plans`,
      payload: {
        name: "pro",
        features: { "api.calls": { usage: true, limit: 100, unit: "call", pricePerUnit: 2 } },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("metered price");
  });

  it("keeps plain included features", async () => {
    const a = await seedApp("plain-features");
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/applications/${a.id}/plans`,
      payload: { name: "pro", features: { seats: 5, sso: true, tier: "gold" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ plan: { features: unknown } }>().plan.features).toEqual({
      seats: 5,
      sso: true,
      tier: "gold",
    });
  });

  it("refuses a Stripe Price id supplied by the caller on a price", async () => {
    const a = await seedApp("strict-price");
    const plan = await createPlan(a.id, "pro");
    const res = await createPrice(a.id, plan.id, { ...fixed, stripePriceId: "price_x" });
    expect(res.statusCode).toBe(400);
  });
});
