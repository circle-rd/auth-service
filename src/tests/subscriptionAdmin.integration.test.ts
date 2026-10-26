import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type * as EventBusModule from "../services/event-bus.js";
import { applicationRoutes } from "../routes/admin/applications.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlans,
  userApplications,
  userSubscriptionEvents,
  userSubscriptions,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { and, eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
// Keep the live-notification off the real bus; it is asserted in the unit tests.
vi.mock("../services/event-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EventBusModule>();
  return { ...actual, publishEvent: vi.fn() };
});

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(applicationRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<infer T>
  ? T
  : never;

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession("sa-1") as unknown as SessionLike,
  );
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
  name = "basic",
  isDefault = false,
) {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: appId, name, features: {}, isDefault })
    .returning();
  return plan!;
}

async function seedUser(id = "user-1") {
  await db.insert(userTable).values({
    id,
    name: "Test User",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedAccess(
  userId: string,
  appId: string,
  planId: string | null,
) {
  await db
    .insert(userApplications)
    .values({ userId, applicationId: appId, isActive: true, subscriptionPlanId: planId });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("admin subscription management", () => {
  it("PATCH plan → canonical sub, mirror, audit entry and live event", async () => {
    await seedUser();
    const a = await seedApp();
    const planA = await seedPlan(a.id, "free", true);
    const planB = await seedPlan(a.id, "pro");
    await seedAccess("user-1", a.id, planA.id);
    await db.insert(userSubscriptions).values({
      userId: "user-1",
      applicationId: a.id,
      planId: planA.id,
      isActive: true,
    });
    asAdmin();

    const res = await app.inject({
      method: "PATCH",
      url: `/${a.id}/users/user-1`,
      payload: { subscriptionPlanId: planB.id, reason: "customer upgrade" },
    });
    expect(res.statusCode).toBe(200);

    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, "user-1"),
          eq(userSubscriptions.applicationId, a.id),
        ),
      );
    expect(sub!.planId).toBe(planB.id);

    const [access] = await db
      .select()
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, "user-1"),
          eq(userApplications.applicationId, a.id),
        ),
      );
    expect(access!.subscriptionPlanId).toBe(planB.id);

    const events = await db
      .select()
      .from(userSubscriptionEvents)
      .where(eq(userSubscriptionEvents.userId, "user-1"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      applicationId: a.id,
      actorUserId: "sa-1",
      source: "admin",
      action: "changed",
      fromPlanId: planA.id,
      toPlanId: planB.id,
      reason: "customer upgrade",
    });
  });

  it("PATCH plan without a reason → 400 and nothing written", async () => {
    await seedUser();
    const a = await seedApp();
    const planB = await seedPlan(a.id, "pro");
    await seedAccess("user-1", a.id, null);
    asAdmin();

    const res = await app.inject({
      method: "PATCH",
      url: `/${a.id}/users/user-1`,
      payload: { subscriptionPlanId: planB.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("APP_001");

    const subs = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, "user-1"));
    expect(subs).toHaveLength(0);
  });

  it("PATCH with a foreign plan → 404 and no partial mutation", async () => {
    await seedUser();
    const a = await seedApp("app-a");
    const other = await seedApp("app-b");
    const foreignPlan = await seedPlan(other.id, "foreign");
    await seedAccess("user-1", a.id, null);
    asAdmin();

    const res = await app.inject({
      method: "PATCH",
      url: `/${a.id}/users/user-1`,
      payload: {
        isActive: false,
        subscriptionPlanId: foreignPlan.id,
        reason: "nope",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SUB_001");

    // The access row must be untouched: the plan is validated before any write.
    const [access] = await db
      .select()
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, "user-1"),
          eq(userApplications.applicationId, a.id),
        ),
      );
    expect(access!.isActive).toBe(true);
  });

  it("PATCH with only expiresAt keeps the plan and updates the expiry", async () => {
    await seedUser();
    const a = await seedApp();
    const plan = await seedPlan(a.id, "pro");
    await seedAccess("user-1", a.id, plan.id);
    await db.insert(userSubscriptions).values({
      userId: "user-1",
      applicationId: a.id,
      planId: plan.id,
      isActive: true,
    });
    asAdmin();

    const res = await app.inject({
      method: "PATCH",
      url: `/${a.id}/users/user-1`,
      payload: { expiresAt: "2027-01-01T00:00:00.000Z", reason: "extended" },
    });
    expect(res.statusCode).toBe(200);

    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, "user-1"),
          eq(userSubscriptions.applicationId, a.id),
        ),
      );
    expect(sub!.planId).toBe(plan.id);
    expect(sub!.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");

    const events = await db
      .select()
      .from(userSubscriptionEvents)
      .where(eq(userSubscriptionEvents.userId, "user-1"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "changed", reason: "extended" });
  });

  it("POST grant with subscriptionPlanId assigns that plan", async () => {
    await seedUser();
    const a = await seedApp();
    await seedPlan(a.id, "free", true);
    const pro = await seedPlan(a.id, "pro");
    asAdmin();

    const res = await app.inject({
      method: "POST",
      url: `/${a.id}/users`,
      payload: { userId: "user-1", subscriptionPlanId: pro.id },
    });
    expect(res.statusCode).toBe(201);

    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, "user-1"));
    expect(sub!.planId).toBe(pro.id);

    const events = await db
      .select()
      .from(userSubscriptionEvents)
      .where(eq(userSubscriptionEvents.userId, "user-1"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "admin",
      action: "assigned",
      toPlanId: pro.id,
    });
  });

  it("GET subscriptions returns compact rows for the financial tab", async () => {
    await seedUser();
    const a = await seedApp();
    const free = await seedPlan(a.id, "free", true);
    asAdmin();

    const grant = await app.inject({
      method: "POST",
      url: `/${a.id}/users`,
      payload: { userId: "user-1" },
    });
    expect(grant.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/${a.id}/subscriptions`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscriptions: Array<{ userId: string; planId: string; isActive: boolean }>;
    }>();
    expect(body.subscriptions).toEqual([
      { userId: "user-1", planId: free.id, isActive: true },
    ]);
  });

  it("POST grant without a plan falls back to the default plan", async () => {
    await seedUser();
    const a = await seedApp();
    const free = await seedPlan(a.id, "free", true);
    await seedPlan(a.id, "pro");
    asAdmin();

    const res = await app.inject({
      method: "POST",
      url: `/${a.id}/users`,
      payload: { userId: "user-1" },
    });
    expect(res.statusCode).toBe(201);

    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, "user-1"));
    expect(sub!.planId).toBe(free.id);
  });

  it("POST bulk with subscriptionPlanId applies it to every grantee", async () => {
    await seedUser("user-1");
    await seedUser("user-2");
    const a = await seedApp();
    await seedPlan(a.id, "free", true);
    const pro = await seedPlan(a.id, "pro");
    asAdmin();

    const res = await app.inject({
      method: "POST",
      url: `/${a.id}/users/bulk`,
      payload: { userIds: ["user-1", "user-2"], subscriptionPlanId: pro.id },
    });
    expect(res.statusCode).toBe(201);

    const subs = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.applicationId, a.id));
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.planId === pro.id)).toBe(true);
  });
});
