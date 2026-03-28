import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { rolesRoutes } from "./roles.js";

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Admin — rolesRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(rolesRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  // ── Auth guard ─────────────────────────────────────────────────────────

  it("GET /:appId/roles → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/roles`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /:appId/roles → 403 when authenticated as regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/roles`,
    });
    expect(res.statusCode).toBe(403);
  });

  // ── GET /:appId/roles — app not found ────────────────────────────────

  it("GET /:appId/roles → 404 when app does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/roles`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /:appId/roles — validation ──────────────────────────────────

  it("POST /:appId/roles → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/roles`,
      payload: { name: "editor" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /:appId/roles → 400 when name is missing", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    // mock ensureApp to pass (returns an app)
    mockDb.select.mockImplementationOnce(() => makeChain([{ id: APP_ID }]));
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/roles`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /:appId/permissions ───────────────────────────────────────────

  it("GET /:appId/permissions → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/permissions`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /:appId/permissions → 404 when app does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "GET",
      url: `/applications/${APP_ID}/permissions`,
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /:appId/permissions — validation ─────────────────────────────

  it("POST /:appId/permissions → 400 when resource is missing", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([{ id: APP_ID }]));
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/permissions`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /:appId/permissions → 400 when resource format is invalid", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([{ id: APP_ID }]));
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/permissions`,
      payload: { resource: "bad resource!" },
    });
    expect(res.statusCode).toBe(400);
  });
});
