import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { usersRoutes } from "./users.js";

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
      offset: () => c,
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
  auth: {
    api: {
      getSession: mockGetSession,
      listUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }),
      createUser: vi.fn(),
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", role: "admin" } };

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Admin — usersRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(usersRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  // ── Auth guard ─────────────────────────────────────────────────────────

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

  // ── GET / ─────────────────────────────────────────────────────────────

  it("GET / → 200 with users + total", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { users: unknown[]; total: number };
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  // ── POST / — validation ───────────────────────────────────────────────

  it("POST / → 400 when email is missing", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { name: "New User", password: "password123" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST / → 400 when password is too short", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "New User",
        email: "test@example.com",
        password: "short",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST / → 400 when body is empty", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "POST", url: "/", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /:id — not found ──────────────────────────────────────────────

  it("GET /:id → 404 when user does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/nonexistent-id" });
    expect(res.statusCode).toBe(404);
  });

  // ── PATCH /:id — validation ───────────────────────────────────────────

  it("PATCH /:id → 400 when role is invalid", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "PATCH",
      url: "/some-user-id",
      payload: { role: "superowner" },
    });
    expect(res.statusCode).toBe(400);
  });
});
