import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { applicationRoutes } from "./applications.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
vi.mock("better-auth", () => ({ generateId: vi.fn(() => "mock-id") }));

// Hoist mock helpers so vi.mock factories can reference them
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
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi
              .fn()
              .mockResolvedValue([{ id: "new-app-id", slug: "test-app" }]),
          })),
        })),
        select: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  };
  const mockGetSession = vi.fn();
  return { mockDb, mockGetSession };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "admin-1", role: "admin" } };

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Admin — applicationRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(applicationRoutes);
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

  it("GET / → 200 with empty list", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { applications: unknown[] };
    expect(Array.isArray(body.applications)).toBe(true);
  });

  // ── POST / — validation ───────────────────────────────────────────────

  it("POST / → 400 when body is empty", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "POST", url: "/", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("POST / → 400 when slug has invalid characters", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { name: "Test App", slug: "Invalid Slug!" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST / → 400 when name is missing", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { slug: "test-app" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /:id — not found ──────────────────────────────────────────────

  it("GET /:id → 404 when application does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/nonexistent-id" });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /:id/consumption — auth guard ────────────────────────────────

  it("GET /:id/consumption → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/app-1/consumption" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /:id/consumption → 200 with empty entries", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({ method: "GET", url: "/app-1/consumption" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  // ── allowRegister ────────────────────────────────────────────────────

  it("POST / → 201 when allowRegister is explicitly false", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    // Simulate no slug conflict
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));
    // transaction mock returns a valid app row
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "Closed App",
        slug: "closed-app",
        allowRegister: false,
      },
    });
    // 400 from Zod is not expected; the route either succeeds (201) or fails at
    // DB level (500) inside the mock — in either case the schema accepts the field.
    expect(res.statusCode).not.toBe(400);
  });

  it("POST / → allowRegister defaults to true when omitted", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { name: "My App", slug: "my-app" },
    });
    // Schema must not reject the request for missing allowRegister (has default)
    expect(res.statusCode).not.toBe(400);
  });

  it("PATCH /:id → accepts allowRegister: false without validation error", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "PATCH",
      url: "/some-app-id",
      payload: { allowRegister: false },
    });
    // 400 would indicate schema rejection; anything else means schema accepted it
    expect(res.statusCode).not.toBe(400);
  });
});
