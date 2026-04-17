import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { plansRoutes } from "../routes/admin/plans.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { applications, subscriptionPlans, subscriptionPlanPrices, userSubscriptions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";
import { user as userTable } from "../db/auth-schema.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
// Stripe is optional — mock it as absent so tests don't need real credentials
vi.mock("../services/stripe.js", () => ({ stripe: null }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(plansRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never;

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession() as SessionLike,
  );
}

async function seedApp(slug = "test-app") {
  const [app] = await db
    .insert(applications)
    .values({
      name: "Test App",
      slug,
      isActive: true,
    })
    .returning();
  return app!;
}

async function seedPlan(appId: string, name = "basic", isDefault = false) {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      applicationId: appId,
      name,
      features: {},
      isDefault,
    })
    .returning();
  return plan!;
}

async function seedPrice(
  planId: string,
  opts: { name?: string; amount?: string; currency?: string; interval?: string } = {},
) {
  const [price] = await db
    .insert(subscriptionPlanPrices)
    .values({
      planId,
      name: opts.name ?? "monthly",
      amount: opts.amount ?? "999",
      currency: opts.currency ?? "usd",
      interval: opts.interval ?? "month",
    })
    .returning();
  return price!;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("plansRoutes integration", () => {
  it("401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/applications/app-1/plans",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET plans → 404 when application does not exist", async () => {
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/applications/00000000-0000-0000-0000-000000000000/plans",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET plans → empty list", async () => {
    const seeded = await seedApp();
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${seeded.id}/plans`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ plans: unknown[] }>();
    expect(body.plans).toHaveLength(0);
  });

  it("POST plan → creates plan", async () => {
    const seeded = await seedApp();
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans`,
      payload: { name: "pro", isDefault: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ plan: { name: string; isDefault: boolean } }>();
    expect(body.plan.name).toBe("pro");
  });

  it("POST plan → new isDefault demotes existing default", async () => {
    const seeded = await seedApp();
    await seedPlan(seeded.id, "free", true);

    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans`,
      payload: { name: "enterprise", isDefault: true },
    });
    expect(res.statusCode).toBe(201);

    // Verify old default is now false
    const plans = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.applicationId, seeded.id));

    const free = plans.find((p) => p.name === "free");
    const enterprise = plans.find((p) => p.name === "enterprise");
    expect(free?.isDefault).toBe(false);
    expect(enterprise?.isDefault).toBe(true);
  });

  it("DELETE plan → 400 when plan has active subscribers", async () => {
    const seeded = await seedApp();
    const plan = await seedPlan(seeded.id, "paid");

    // Seed a user + subscription
    await db.insert(userTable).values({
      id: "u1",
      name: "User",
      email: "u@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(userSubscriptions).values({
      userId: "u1",
      applicationId: seeded.id,
      planId: plan.id,
      isActive: true,
    });

    asAdmin();
    const res = await app.inject({
      method: "DELETE",
      url: `/applications/${seeded.id}/plans/${plan.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SUB_003");
  });

  it("DELETE plan → 204 when no active subscribers", async () => {
    const seeded = await seedApp();
    const plan = await seedPlan(seeded.id, "old-plan");

    asAdmin();
    const res = await app.inject({
      method: "DELETE",
      url: `/applications/${seeded.id}/plans/${plan.id}`,
    });
    expect(res.statusCode).toBe(204);
  });

  // ── POST price ─────────────────────────────────────────────────────────

  it("POST price → 400 when amount is negative", async () => {
    const seeded = await seedApp();
    const plan = await seedPlan(seeded.id, "pro");
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans/${plan.id}/prices`,
      payload: { name: "monthly", amount: -1, currency: "usd", interval: "month" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("APP_001");
  });

  it("POST price → 201 when amount is 0 (free tier)", async () => {
    const seeded = await seedApp();
    const plan = await seedPlan(seeded.id, "free");
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans/${plan.id}/prices`,
      payload: { name: "free", amount: 0, currency: "usd", interval: "month" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ price: { amount: string; currency: string } }>();
    expect(body.price.amount).toBe("0");
    expect(body.price.currency).toBe("usd");
  });

  it("POST price → 201 stores interval correctly for one_time", async () => {
    const seeded = await seedApp();
    const plan = await seedPlan(seeded.id, "lifetime");
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans/${plan.id}/prices`,
      payload: { name: "lifetime", amount: 9900, currency: "eur", interval: "one_time" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ price: { interval: string; amount: string } }>();
    expect(body.price.interval).toBe("one_time");
    expect(body.price.amount).toBe("9900");
  });

  it("POST price → 404 when plan does not exist", async () => {
    const seeded = await seedApp();
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans/00000000-0000-0000-0000-000000000000/prices`,
      payload: { name: "monthly", amount: 999, currency: "usd", interval: "month" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SUB_001");
  });

  it("POST plan with metered features → 201 stores features correctly", async () => {
    const seeded = await seedApp();
    asAdmin();
    const features = {
      apiCalls: { type: "metered", limit: 1000 },
      storage: { type: "fixed", limit: 5 },
    };
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/plans`,
      payload: { name: "metered-plan", isDefault: false, features },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ plan: { features: unknown; name: string } }>();
    expect(body.plan.name).toBe("metered-plan");
    expect(body.plan.features).toMatchObject(features);
  });
});
