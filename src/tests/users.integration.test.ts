import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { usersRoutes } from "../routes/admin/users.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import {
  makeAdminSession,
  makeSuperadminSession,
} from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(usersRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedUser(
  id: string,
  opts: { role?: string; email?: string } = {},
) {
  await db.insert(userTable).values({
    id,
    name: `User ${id}`,
    email: opts.email ?? `${id}@example.com`,
    emailVerified: true,
    role: opts.role ?? "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never;

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeAdminSession() as SessionLike,
  );
}

function asSuperadmin(id = "superadmin-1") {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession(id) as SessionLike,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Admin — usersRoutes integration", () => {
  // ── Auth guard ───────────────────────────────────────────────────────────

  it("GET / → 401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "listUsers").mockResolvedValue({ users: [], total: 0 });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("GET / → 403 for regular user", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      { user: { id: "u1", role: "user" } } as SessionLike,
    );
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(403);
  });

  // ── GET / ────────────────────────────────────────────────────────────────

  it("GET / → returns paginated users via auth.api.listUsers", async () => {
    asAdmin();
    vi.spyOn(auth.api, "listUsers").mockResolvedValue({
      users: [{ id: "u1", email: "u1@example.com" }] as never,
      total: 1,
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: unknown[]; total: number; page: number; limit: number }>();
    expect(body.total).toBe(1);
    expect(body.users).toHaveLength(1);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  // ── DELETE /:id — last-superadmin guard ──────────────────────────────────

  it("DELETE /:id → 400 USR_002 when deleting the last superadmin", async () => {
    // Seed a single superadmin
    await seedUser("sa-1", { role: "superadmin" });

    // The caller is an admin (not the same user)
    asSuperadmin("sa-caller");

    // auth.api.getUser returns the target
    vi.spyOn(auth.api, "getUser" as never).mockResolvedValue({
      id: "sa-1",
      role: "superadmin",
      email: "sa-1@example.com",
    } as never);

    // getSession must also return the caller for the self-delete check
    // Already set by asSuperadmin — caller id is "sa-caller", target is "sa-1"

    const res = await app.inject({ method: "DELETE", url: "/sa-1" });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("USR_002");
  });

  it("DELETE /:id → 204 when deleting a superadmin while another exists", async () => {
    // Seed two superadmins
    await seedUser("sa-1", { role: "superadmin" });
    await seedUser("sa-2", { role: "superadmin" });

    asSuperadmin("sa-2");

    vi.spyOn(auth.api, "getUser" as never).mockResolvedValue({
      id: "sa-1",
      role: "superadmin",
      email: "sa-1@example.com",
    } as never);

    const res = await app.inject({ method: "DELETE", url: "/sa-1" });
    expect(res.statusCode).toBe(204);
  });

  it("DELETE /:id → 204 when deleting a normal user", async () => {
    await seedUser("u-target", { role: "user" });

    asAdmin();

    vi.spyOn(auth.api, "getUser" as never).mockResolvedValue({
      id: "u-target",
      role: "user",
      email: "u-target@example.com",
    } as never);

    const res = await app.inject({ method: "DELETE", url: "/u-target" });
    expect(res.statusCode).toBe(204);

    // Confirm the row is gone from the DB
    const rows = await db
      .select()
      .from(userTable)
      .where((await import("drizzle-orm")).eq(userTable.id, "u-target"));
    expect(rows).toHaveLength(0);
  });

  it("DELETE /:id → 400 USR_003 when admin tries to delete themselves", async () => {
    await seedUser("admin-1", { role: "admin" });

    // caller IS the target
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      makeAdminSession("admin-1") as SessionLike,
    );
    vi.spyOn(auth.api, "getUser" as never).mockResolvedValue({
      id: "admin-1",
      role: "admin",
      email: "admin-1@example.com",
    } as never);

    const res = await app.inject({ method: "DELETE", url: "/admin-1" });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("USR_003");
  });

  it("DELETE /:id → 404 when user not found", async () => {
    asAdmin();
    vi.spyOn(auth.api, "getUser" as never).mockRejectedValue(
      new Error("Not found"),
    );

    const res = await app.inject({
      method: "DELETE",
      url: "/non-existent-id",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("USR_001");
  });
});
