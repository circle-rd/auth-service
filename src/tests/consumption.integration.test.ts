import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { consumptionRoutes } from "../routes/consumption.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import {
  applications,
  userApplications,
  consumptionAggregates,
  consumptionEntries,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { and, eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(consumptionRoutes);
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

async function seedAppAndUser() {
  const [a] = await db
    .insert(applications)
    .values({
      name: "Test App",
      slug: "test-app",
      isActive: true,
    })
    .returning();

  await db.insert(userTable).values({
    id: "u1",
    name: "User",
    email: "u@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(userApplications).values({
    userId: "u1",
    applicationId: a!.id,
    isActive: true,
  });

  return { app: a!, userId: "u1" };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("consumptionRoutes integration", () => {
  it("POST / → 403 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        applicationId: "00000000-0000-0000-0000-000000000001",
        userId: "u1",
        key: "tokens",
        value: 10,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST / → 404 when user+app relationship not found", async () => {
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        applicationId: "00000000-0000-0000-0000-000000000001",
        userId: "nonexistent",
        key: "tokens",
        value: 10,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("CONS_003");
  });

  it("POST / → creates consumption entry and aggregate", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        applicationId: seededApp.id,
        userId,
        key: "tokens",
        value: 42,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; aggregate: { key: string; total: string } }>();
    expect(body.success).toBe(true);
    expect(body.aggregate.key).toBe("tokens");
    expect(Number(body.aggregate.total)).toBe(42);
  });

  it("POST / → accumulates on subsequent calls", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();

    const post = (value: number) =>
      app.inject({
        method: "POST",
        url: "/",
        payload: { applicationId: seededApp.id, userId, key: "tokens", value },
      });

    await post(10);
    await post(20);
    const res = await post(5);

    const body = res.json<{ aggregate: { total: string } }>();
    expect(Number(body.aggregate.total)).toBe(35);
  });

  it("POST / → 400 on invalid key format", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        applicationId: seededApp.id,
        userId,
        key: "invalid key!",
        value: 1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("CONS_001");
  });

  it("GET /:userId/:applicationId → returns all aggregates", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();

    // Seed two entries
    await app.inject({
      method: "POST",
      url: "/",
      payload: { applicationId: seededApp.id, userId, key: "tokens", value: 5 },
    });
    await app.inject({
      method: "POST",
      url: "/",
      payload: { applicationId: seededApp.id, userId, key: "requests", value: 3 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/${userId}/${seededApp.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ aggregates: { key: string }[] }>();
    expect(body.aggregates).toHaveLength(2);
    const keys = body.aggregates.map((a) => a.key).sort();
    expect(keys).toEqual(["requests", "tokens"]);
  });

  it("GET /:userId/:applicationId/:key → returns single aggregate", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();

    await app.inject({
      method: "POST",
      url: "/",
      payload: { applicationId: seededApp.id, userId, key: "tokens", value: 7 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/${userId}/${seededApp.id}/tokens`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ aggregate: { key: string; total: string } }>();
    expect(body.aggregate.key).toBe("tokens");
    expect(Number(body.aggregate.total)).toBe(7);
  });

  it("GET /:userId/:applicationId/:key → 404 when not found", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/${userId}/${seededApp.id}/missing-key`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /:userId/:applicationId/:key → removes aggregate and entries", async () => {
    const { app: seededApp, userId } = await seedAppAndUser();
    asAdmin();

    await app.inject({
      method: "POST",
      url: "/",
      payload: { applicationId: seededApp.id, userId, key: "tokens", value: 10 },
    });

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/${userId}/${seededApp.id}/tokens`,
    });
    expect(deleteRes.statusCode).toBe(204);

    // Verify DB is clean
    const aggRows = await db
      .select()
      .from(consumptionAggregates)
      .where(
        and(
          eq(consumptionAggregates.userId, userId),
          eq(consumptionAggregates.applicationId, seededApp.id),
          eq(consumptionAggregates.key, "tokens"),
        ),
      );
    expect(aggRows).toHaveLength(0);

    const entryRows = await db
      .select()
      .from(consumptionEntries)
      .where(
        and(
          eq(consumptionEntries.userId, userId),
          eq(consumptionEntries.applicationId, seededApp.id),
          eq(consumptionEntries.key, "tokens"),
        ),
      );
    expect(entryRows).toHaveLength(0);
  });
});
