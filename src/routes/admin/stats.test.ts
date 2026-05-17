import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { statsRoutes } from "./stats.js";

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
      offset: () => c,
      groupBy: () => c,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
    };
    return c;
  }
  const mockDb = {
    select: vi.fn(() => makeChain()),
    execute: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([])),
  };
  const mockGetSession = vi.fn();
  return { mockDb, mockGetSession, makeChain };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

const adminSession = { user: { id: "admin-1", role: "admin" } };

describe("Admin — statsRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(statsRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    mockDb.select.mockImplementation(() => makeChain());
    mockDb.execute.mockImplementation(() => Promise.resolve([]));
  });

  // ── Auth guard ─────────────────────────────────────────────────────────

  it("GET /active-users → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/active-users" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /active-users → 403 when authenticated as regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({ method: "GET", url: "/active-users" });
    expect(res.statusCode).toBe(403);
  });

  // ── /active-users ──────────────────────────────────────────────────────

  it("GET /active-users → returns distinct online count", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([{ count: 3 }]));
    const res = await app.inject({ method: "GET", url: "/active-users" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 3 });
  });

  // ── /logins ────────────────────────────────────────────────────────────

  it("GET /logins → 400 on invalid range", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/logins?range=99d" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /logins → returns dense 7-day zero-filled series by default", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.execute.mockResolvedValueOnce([]);
    const res = await app.inject({ method: "GET", url: "/logins" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      range: string;
      series: { date: string; count: number }[];
      total: number;
    };
    expect(body.range).toBe("7d");
    expect(body.series).toHaveLength(7);
    expect(body.series.every((p) => p.count === 0)).toBe(true);
    expect(body.total).toBe(0);
  });

  it("GET /logins → returns dense 30-day series when range=30d", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.execute.mockResolvedValueOnce([]);
    const res = await app.inject({ method: "GET", url: "/logins?range=30d" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { series: unknown[] };
    expect(body.series).toHaveLength(30);
  });

  it("GET /logins → backfills sparse raw rows into dense series", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayKey = today.toISOString().slice(0, 10);
    mockDb.execute.mockResolvedValueOnce([{ day: todayKey, count: 5 }]);
    const res = await app.inject({ method: "GET", url: "/logins" });
    const body = JSON.parse(res.body) as {
      series: { date: string; count: number }[];
      total: number;
    };
    expect(body.total).toBe(5);
    expect(body.series[body.series.length - 1]).toEqual({
      date: todayKey,
      count: 5,
    });
  });

  // ── /applications-activity ─────────────────────────────────────────────

  it("GET /applications-activity → empty list when no applications", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() => makeChain([]));
    const res = await app.inject({
      method: "GET",
      url: "/applications-activity",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ applications: [] });
  });

  it("GET /applications-activity → returns sparkline + KPI per app", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select.mockImplementationOnce(() =>
      makeChain([{ id: "app-1" }, { id: "app-2" }]),
    );
    mockDb.execute
      .mockResolvedValueOnce([{ appId: "app-1", day: "2026-05-17", count: 4 }])
      .mockResolvedValueOnce([{ appId: "app-1", online: 2 }]);
    const res = await app.inject({
      method: "GET",
      url: "/applications-activity",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      applications: {
        appId: string;
        online: number;
        last7dLogins: number;
        sparkline: number[];
      }[];
    };
    expect(body.applications).toHaveLength(2);
    const app1 = body.applications.find((a) => a.appId === "app-1");
    expect(app1?.online).toBe(2);
    expect(app1?.sparkline).toHaveLength(7);
    expect(app1?.sparkline.every((n) => typeof n === "number")).toBe(true);
    const app2 = body.applications.find((a) => a.appId === "app-2");
    expect(app2?.online).toBe(0);
    expect(app2?.last7dLogins).toBe(0);
  });
});
