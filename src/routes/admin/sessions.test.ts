import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { sessionsRoutes } from "./sessions.js";

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
    selectDistinct: vi.fn(() => makeChain()),
  };
  const mockGetSession = vi.fn();
  return { mockDb, mockGetSession, makeChain };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

const adminSession = { user: { id: "admin-1", role: "admin" } };

describe("Admin — sessionsRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(sessionsRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    mockDb.select.mockImplementation(() => makeChain());
    mockDb.selectDistinct.mockImplementation(() => makeChain());
  });

  it("GET / → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("GET / → 403 when authenticated as regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(403);
  });

  it("GET / → 200 with empty list when no active sessions", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockDb.select
      .mockImplementationOnce(() => makeChain([{ total: 0 }])) // count
      .mockImplementationOnce(() => makeChain([])); // list
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      total: number;
      sessions: unknown[];
    };
    expect(body.total).toBe(0);
    expect(body.sessions).toEqual([]);
  });

  it("GET / → enriches sessions with user info and applications array", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const createdAt = new Date("2026-05-17T10:00:00Z");
    const expiresAt = new Date("2026-05-18T10:00:00Z");
    mockDb.select
      .mockImplementationOnce(() => makeChain([{ total: 1 }]))
      .mockImplementationOnce(() =>
        makeChain([
          {
            id: "sess-1",
            userId: "user-1",
            userAgent: "UA",
            ipAddress: "1.2.3.4",
            createdAt,
            expiresAt,
            userName: "Alice",
            userEmail: "alice@example.com",
            userImage: null,
          },
        ]),
      );
    mockDb.selectDistinct.mockImplementationOnce(() =>
      makeChain([
        {
          userId: "user-1",
          id: "app-1",
          name: "App 1",
          slug: "app-1",
          icon: null,
        },
      ]),
    );

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      total: number;
      sessions: {
        id: string;
        user: { name: string; email: string };
        applications: { id: string; slug: string }[];
      }[];
    };
    expect(body.total).toBe(1);
    expect(body.sessions[0]?.user.name).toBe("Alice");
    expect(body.sessions[0]?.user.email).toBe("alice@example.com");
    expect(body.sessions[0]?.applications).toEqual([
      { id: "app-1", name: "App 1", slug: "app-1", icon: null },
    ]);
  });
});
