import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { usersRoutes } from "./users.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockDb, mockGetSession } = vi.hoisted(() => {
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
  return { mockDb, mockGetSession };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
      listUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }),
      createUser: vi.fn(),
      sendVerificationEmail: vi.fn().mockResolvedValue({ status: true }),
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", role: "admin" } };
const superadminSession = { user: { id: "root-1", role: "superadmin" } };

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

  it("POST / → 201 when creation succeeds (no-op mail transport)", async () => {
    const { auth } = await import("../../auth.js");
    (
      auth.api.createUser as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ user: { id: "u2", email: "new@example.com" } });
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "New User",
        email: "new@example.com",
        password: "password123",
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── POST / — the role actually forwarded to BetterAuth ────────────────
  //
  // The native `/admin/create-user` endpoint requires `user:set-role` as soon
  // as a role is present, and the `admin` role does not hold it. The mock above
  // cannot reproduce that refusal, so the body shape is asserted here — it is
  // the only level at which this contract is observable.

  it("POST / → 201 and omits `role` for an admin creating a user", async () => {
    const { auth } = await import("../../auth.js");
    const createUser = auth.api.createUser as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
      mock: { calls: [{ body?: Record<string, unknown> }][] };
    };
    createUser.mockResolvedValueOnce({
      user: { id: "u3", email: "plain@example.com" },
    });
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "Plain User",
        email: "plain@example.com",
        password: "password123",
        role: "user",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = createUser.mock.calls.at(-1)?.[0]?.body;
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty("role");
  });

  it("POST / → 201 and sends `role` for a superadmin creating an admin", async () => {
    const { auth } = await import("../../auth.js");
    const createUser = auth.api.createUser as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
      mock: { calls: [{ body?: Record<string, unknown> }][] };
    };
    createUser.mockResolvedValueOnce({
      user: { id: "u4", email: "boss@example.com" },
    });
    // requireAdmin then getCallerRole, in that order.
    mockGetSession.mockResolvedValueOnce(superadminSession);
    mockGetSession.mockResolvedValueOnce(superadminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "Boss",
        email: "boss@example.com",
        password: "password123",
        role: "admin",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = createUser.mock.calls.at(-1)?.[0]?.body;
    expect(body?.role).toBe("admin");
  });

  it("POST / → 403 for an admin requesting the admin role", async () => {
    const { auth } = await import("../../auth.js");
    const createUser = auth.api.createUser as unknown as {
      mock: { calls: unknown[] };
    };
    const before = createUser.mock.calls.length;
    // requireAdmin then getCallerRole: the caller is an admin, not a superadmin.
    mockGetSession.mockResolvedValueOnce(adminSession);
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "Escalated",
        email: "escalated@example.com",
        password: "password123",
        role: "admin",
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as {
      code?: string;
      error?: { code: string };
    };
    expect(body.error?.code ?? body.code).toBe("AUTH_011");
    // The refusal must happen before the native call, not as a side effect of it.
    expect(createUser.mock.calls.length).toBe(before);
  });

  it("POST /import → omits `role` on user rows and sends it on admin rows", async () => {
    const { auth } = await import("../../auth.js");
    const createUser = auth.api.createUser as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
      mock: { calls: [{ body?: Record<string, unknown> }][] };
    };
    createUser.mockResolvedValueOnce({ user: { id: "u5" } });
    createUser.mockResolvedValueOnce({ user: { id: "u6" } });
    // requireAdmin then getCallerRole.
    mockGetSession.mockResolvedValueOnce(superadminSession);
    mockGetSession.mockResolvedValueOnce(superadminSession);
    const res = await app.inject({
      method: "POST",
      url: "/import",
      payload: {
        users: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Root", email: "root@example.com", role: "admin" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const calls = createUser.mock.calls.slice(-2);
    expect(calls[0]?.[0]?.body).not.toHaveProperty("role");
    expect(calls[1]?.[0]?.body?.role).toBe("admin");
  });

  // ── POST /:id/send-verification & /:id/verify-email ───────────────────

  it("POST /:id/send-verification → 404 when user does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/missing-id/send-verification",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /:id/verify-email → 404 when user does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/missing-id/verify-email",
    });
    expect(res.statusCode).toBe(404);
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
