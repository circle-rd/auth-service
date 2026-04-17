import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { userRoutes } from "../routes/user.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import {
  applications,
  userApplications,
  subscriptionPlans,
  subscriptionPlanPrices,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeUserSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(userRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never;

function asUser(id = "user-1") {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeUserSession(id) as SessionLike,
  );
}

async function seedApp(slug = "test-app") {
  const [a] = await db
    .insert(applications)
    .values({ name: "Test App", slug, isActive: true })
    .returning();
  return a!;
}

async function seedUser(id = "user-1", email = "user@example.com") {
  await db.insert(userTable).values({
    id,
    name: "Test User",
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedPlan(
  appId: string,
  name = "basic",
  features: Record<string, unknown> = {},
) {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: appId, name, features, isDefault: false })
    .returning();
  return plan!;
}

async function seedPrice(
  planId: string,
  amount = "999",
  currency = "usd",
  interval = "month",
) {
  const [price] = await db
    .insert(subscriptionPlanPrices)
    .values({ planId, name: "monthly", amount, currency, interval })
    .returning();
  return price!;
}

async function grantAccess(
  userId: string,
  appId: string,
  planId: string | null = null,
) {
  await db.insert(userApplications).values({
    userId,
    applicationId: appId,
    isActive: true,
    subscriptionPlanId: planId,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("userRoutes — GET /subscription", () => {
  it("401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(401);
  });

  it("200 with empty subscriptions when user has no app access", async () => {
    await seedUser();
    asUser();
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ subscriptions: unknown[] }>();
    expect(body.subscriptions).toHaveLength(0);
  });

  it("200 with plan null when user has access but no plan assigned", async () => {
    await seedUser();
    const a = await seedApp();
    await grantAccess("user-1", a.id, null);
    asUser();
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscriptions: Array<{ applicationSlug: string; plan: null }>;
    }>();
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0]!.applicationSlug).toBe("test-app");
    expect(body.subscriptions[0]!.plan).toBeNull();
  });

  it("200 with plan details when subscription plan is assigned", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id, "pro");
    await grantAccess("user-1", a.id, plan.id);
    asUser();
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscriptions: Array<{ plan: { name: string; prices: unknown[] } | null }>;
    }>();
    expect(body.subscriptions[0]!.plan?.name).toBe("pro");
  });

  it("200 includes prices array in plan when prices exist", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id, "paid");
    await seedPrice(plan.id, "999", "usd", "month");
    await seedPrice(plan.id, "9999", "usd", "year");
    await grantAccess("user-1", a.id, plan.id);
    asUser();
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscriptions: Array<{
        plan: {
          prices: Array<{ amount: string; currency: string; interval: string }>;
        } | null;
      }>;
    }>();
    const prices = body.subscriptions[0]!.plan?.prices ?? [];
    expect(prices).toHaveLength(2);
    expect(prices.find((p) => p.interval === "month")?.amount).toBe("999");
    expect(prices.find((p) => p.interval === "year")?.amount).toBe("9999");
  });

  it("200 prices array is empty when plan has no prices", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id, "free");
    await grantAccess("user-1", a.id, plan.id);
    asUser();
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscriptions: Array<{ plan: { prices: unknown[] } | null }>();
    }>();
    expect(body.subscriptions[0]!.plan?.prices).toHaveLength(0);
  });

  it("200 includes metered features in plan", async () => {
    await seedUser();
    const a = await seedApp();
    const features = { apiCalls: { type: "metered", limit: 5000 } };
    const plan = await seedPlan(a.id, "metered", features);
    await grantAccess("user-1", a.id, plan.id);
    asUser();
    const res = await app.inject({ method: "GET", url: "/subscription" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscriptions: Array<{ plan: { features: unknown } | null }>;
    }>();
    expect(body.subscriptions[0]!.plan?.features).toMatchObject(features);
  });
});
