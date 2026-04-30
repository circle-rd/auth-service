import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { adminConsumptionRoutes } from "./adminConsumption.js";

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
      groupBy: () => c,
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Admin — adminConsumptionRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(adminConsumptionRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  // ── Auth guards ────────────────────────────────────────────────────────

  it("GET /applications/:appId/consumption/monthly → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /applications/:appId/consumption/monthly → 403 when authenticated as regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly`,
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Query param validation ─────────────────────────────────────────────

  it("GET /applications/:appId/consumption/monthly → 400 when year is not a 4-digit number", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly?year=abc`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /applications/:appId/consumption/monthly → 400 when month is out of range", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly?year=2024&month=13`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /applications/:appId/consumption/monthly → 400 when month is zero", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly?year=2024&month=0`,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── App not found ──────────────────────────────────────────────────────

  it("GET /applications/:appId/consumption/monthly → 404 when app does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([]));
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly?year=2024&month=1`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it("GET /applications/:appId/consumption/monthly → 200 with entries array", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? makeChain([{ id: APP_ID }])
        : makeChain([
            { userId: "u1", key: "tokens", total: "42" },
            { userId: "u2", key: "tokens", total: "10" },
          ]);
    });
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly?year=2024&month=6`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ userId: string; key: string; total: string }> }>();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ userId: "u1", key: "tokens", total: "42" });
    mockDb.select.mockImplementation(() => makeChain());
  });

  it("GET /applications/:appId/consumption/monthly → 200 with empty entries when no data", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? makeChain([{ id: APP_ID }]) : makeChain([]);
    });
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/consumption/monthly`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: unknown[] }>().entries).toHaveLength(0);
    mockDb.select.mockImplementation(() => makeChain());
  });
});
