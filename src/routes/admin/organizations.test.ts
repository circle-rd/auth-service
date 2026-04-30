import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { organizationsRoutes } from "./organizations.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockDb, mockGetSession, mockAuthApi } = vi.hoisted(() => {
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
  const mockAuthApi = {
    getSession: mockGetSession,
    createOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    getFullOrganization: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
    createInvitation: vi.fn(),
    cancelInvitation: vi.fn(),
  };
  return { mockDb, mockGetSession, mockAuthApi };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({ auth: { api: mockAuthApi } }));

const adminSession = { user: { id: "admin-1", role: "admin" } };

describe("Admin — organizationsRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(organizationsRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  // ── Auth guard ─────────────────────────────────────────────────────────

  it("PATCH /:id → 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/org-1",
      payload: { name: "New" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH /:id → 403 when authenticated as regular user", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "u1", role: "user" } });
    const res = await app.inject({
      method: "PATCH",
      url: "/org-1",
      payload: { name: "New" },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── PATCH validation ──────────────────────────────────────────────────

  it("PATCH /:id → 400 when body is empty", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "PATCH",
      url: "/org-1",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /:id → 400 when slug has invalid characters", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    const res = await app.inject({
      method: "PATCH",
      url: "/org-1",
      payload: { slug: "Invalid Slug!" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── PATCH not found ───────────────────────────────────────────────────

  it("PATCH /:id → 404 when organization does not exist", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    // First select() → existence check returns []
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }));
    const res = await app.inject({
      method: "PATCH",
      url: "/nonexistent",
      payload: { name: "Whatever" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── PATCH slug conflict ───────────────────────────────────────────────

  it("PATCH /:id → 409 when slug already used by another org", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    // existence check → row found
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: "org-1" }]) }),
      }),
    }));
    // conflict check → row with different id
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: "org-2" }]) }),
      }),
    }));
    const res = await app.inject({
      method: "PATCH",
      url: "/org-1",
      payload: { slug: "taken-slug" },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── PATCH success ─────────────────────────────────────────────────────

  it("PATCH /:id → 200 on successful update", async () => {
    mockGetSession.mockResolvedValueOnce(adminSession);
    // existence
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: "org-1" }]) }),
      }),
    }));
    // returning() → updated row
    mockDb.update.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "org-1",
                name: "Renamed",
                slug: "org-1",
                logo: null,
                metadata: null,
              },
            ]),
        }),
      }),
    }));
    const res = await app.inject({
      method: "PATCH",
      url: "/org-1",
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      organization: { name: string };
    };
    expect(body.organization.name).toBe("Renamed");
  });
});
