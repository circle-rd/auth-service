import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { plansRoutes } from "./plans.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockDb, mockGetSession, makeChain } = vi.hoisted(() => {
  function makeChain(result: unknown[] = []): Record<string, unknown> {
    const p = Promise.resolve(result);
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      leftJoin: () => c,
      innerJoin: () => c,
      orderBy: () => c,
      limit: () => c,
      values: () => c,
      set: () => c,
      returning: () => Promise.resolve(result),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
    };
    return c;
  }

  const mockDb = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  };
  const mockGetSession = vi.fn();
  return { mockDb, mockGetSession, makeChain };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", role: "admin" } };
const APP_ID = "app-uuid-1234";
const PLAN_ID = "plan-uuid-5678";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Admin — plansRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(plansRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  // ── Auth guard ─────────────────────────────────────────────────────────

  it("GET /applications/:appId/plans → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/plans`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /applications/:appId/plans → 403 when authenticated as regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/plans`,
    });
    expect(res.statusCode).toBe(403);
  });

  // ── GET /applications/:appId/plans — app not found ────────────────────

  it("GET /applications/:appId/plans → 404 when app does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/plans`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /applications/:appId/plans — happy path ───────────────────────

  it("GET /applications/:appId/plans → 200 with plans array", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    // first call: ensureApp — returns app; second call: getPlans — returns []
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? makeChain([{ id: APP_ID }]) : makeChain([]);
    });
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/plans`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { plans: unknown[] };
    expect(Array.isArray(body.plans)).toBe(true);
    mockDb.select.mockImplementation(() => makeChain());
  });

  // ── POST /applications/:appId/plans — validation ──────────────────────

  it("POST /applications/:appId/plans → 400 when name is missing", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([{ id: APP_ID }]));
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/plans`,
      payload: { features: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /applications/:appId/plans → 400 when body is empty", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([{ id: APP_ID }]));
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/plans`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ── POST /applications/:appId/users/:userId/subscription — validation ─

  it("POST /applications/:appId/users/:userId/subscription → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/users/user-1/subscription`,
      payload: { planId: PLAN_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /applications/:appId/users/:userId/subscription → 400 when planId is not a UUID", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([{ id: APP_ID }]));
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/users/user-1/subscription`,
      payload: { planId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── DELETE /applications/:appId/plans/:planId — auth ─────────────────

  it("DELETE /applications/:appId/plans/:planId → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "DELETE",
      url: `/applications/${APP_ID}/plans/${PLAN_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
