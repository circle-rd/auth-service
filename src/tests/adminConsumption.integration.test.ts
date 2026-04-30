import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { adminConsumptionRoutes } from "../routes/admin/adminConsumption.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { applications, consumptionEntries } from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(adminConsumptionRoutes);
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
  const [a] = await db
    .insert(applications)
    .values({ name: "Test App", slug, isActive: true })
    .returning();
  return a!;
}

async function seedEntry(
  appId: string,
  userId: string,
  key: string,
  value: number,
  recordedAt: Date,
) {
  await db.insert(consumptionEntries).values({
    applicationId: appId,
    userId,
    key,
    value: String(value),
    recordedAt,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("adminConsumptionRoutes integration", () => {
  it("401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/applications/00000000-0000-0000-0000-000000000001/consumption/monthly",
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 when not admin", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: "u1", role: "user" },
    } as SessionLike);
    const res = await app.inject({
      method: "GET",
      url: "/applications/00000000-0000-0000-0000-000000000001/consumption/monthly",
    });
    expect(res.statusCode).toBe(403);
  });

  it("400 when year query param is invalid", async () => {
    asAdmin();
    const a = await seedApp();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${a.id}/consumption/monthly?year=notayear`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("APP_001");
  });

  it("400 when month is out of valid range", async () => {
    asAdmin();
    const a = await seedApp();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${a.id}/consumption/monthly?year=2024&month=13`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 when app does not exist", async () => {
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/applications/00000000-0000-0000-0000-000000000000/consumption/monthly?year=2024&month=6",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("APP_002");
  });

  it("200 with empty entries when no consumption data", async () => {
    const a = await seedApp();
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${a.id}/consumption/monthly?year=2024&month=6`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: unknown[] }>().entries).toHaveLength(0);
  });

  it("200 aggregates entries grouped by userId and key for the requested month", async () => {
    const a = await seedApp();
    // Two entries for June 2024
    const juneDate = new Date("2024-06-15T10:00:00Z");
    await seedEntry(a.id, "u1", "tokens", 10, juneDate);
    await seedEntry(a.id, "u1", "tokens", 30, juneDate);
    await seedEntry(a.id, "u2", "tokens", 20, juneDate);
    await seedEntry(a.id, "u1", "requests", 5, juneDate);

    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${a.id}/consumption/monthly?year=2024&month=6`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      entries: Array<{ userId: string; key: string; total: string }>;
    }>();
    // Sort for deterministic checks
    const sorted = [...body.entries].sort((a, b) =>
      `${a.userId}:${a.key}`.localeCompare(`${b.userId}:${b.key}`),
    );
    expect(sorted).toHaveLength(3);
    expect(sorted.find((e) => e.userId === "u1" && e.key === "tokens")?.total).toBe("40");
    expect(sorted.find((e) => e.userId === "u2" && e.key === "tokens")?.total).toBe("20");
    expect(sorted.find((e) => e.userId === "u1" && e.key === "requests")?.total).toBe("5");
  });

  it("200 excludes entries from other months", async () => {
    const a = await seedApp();
    const mayDate = new Date("2024-05-20T10:00:00Z");
    const juneDate = new Date("2024-06-10T10:00:00Z");
    await seedEntry(a.id, "u1", "tokens", 100, mayDate);
    await seedEntry(a.id, "u1", "tokens", 50, juneDate);

    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${a.id}/consumption/monthly?year=2024&month=6`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ userId: string; key: string; total: string }> }>();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.total).toBe("50");
  });
});
