import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { sessionsRoutes } from "../routes/admin/sessions.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { user as userTable, session as sessionTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(sessionsRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedUser(id: string) {
  await db.insert(userTable).values({
    id,
    name: "Test User",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedSession(
  id: string,
  userId: string,
  opts: { expired?: boolean } = {},
) {
  const expiresAt = opts.expired
    ? new Date(Date.now() - 1000)
    : new Date(Date.now() + 86_400_000);

  await db.insert(sessionTable).values({
    id,
    token: `token-${id}`,
    userId,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  });
}

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession() as ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/admin/sessions — sessions integration", () => {
  it("401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty list when no active sessions", async () => {
    asAdmin();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; sessions: unknown[]; page: number; limit: number }>();
    expect(body.total).toBe(0);
    expect(body.sessions).toHaveLength(0);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it("returns only active sessions, excludes expired ones", async () => {
    await seedUser("u1");
    await seedSession("s-active", "u1");
    await seedSession("s-expired", "u1", { expired: true });

    asAdmin();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; sessions: { id: string }[] }>();
    expect(body.total).toBe(1);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe("s-active");
  });

  it("paginates correctly", async () => {
    await seedUser("u1");
    for (let i = 0; i < 5; i++) {
      await seedSession(`sess-${i}`, "u1");
    }

    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/?page=1&limit=3",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; sessions: unknown[]; limit: number }>();
    expect(body.total).toBe(5);
    expect(body.sessions).toHaveLength(3);
    expect(body.limit).toBe(3);
  });

  it("response contains the `sessions` key (not `list`)", async () => {
    asAdmin();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const raw = res.json<Record<string, unknown>>();
    expect(raw).toHaveProperty("sessions");
    expect(raw).not.toHaveProperty("list");
  });
});
