import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { rolesRoutes } from "../routes/admin/roles.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { applications, appRoles, userAppRoles } from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(rolesRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never;

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession() as SessionLike,
  );
}

async function seedApp(slug = "app-test") {
  const [a] = await db
    .insert(applications)
    .values({ name: "App", slug, isActive: true })
    .returning();
  return a!;
}

async function seedRole(
  appId: string,
  name = "viewer",
  isDefault = false,
) {
  const [r] = await db
    .insert(appRoles)
    .values({ applicationId: appId, name, isDefault })
    .returning();
  return r!;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("rolesRoutes integration", () => {
  it("401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/applications/app-1/roles",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET roles → empty list", async () => {
    const seeded = await seedApp();
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: `/applications/${seeded.id}/roles`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ roles: unknown[] }>().roles).toHaveLength(0);
  });

  it("POST role → creates role", async () => {
    const seeded = await seedApp("app-create-role");
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/roles`,
      payload: { name: "editor", isDefault: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ role: { name: string; isDefault: boolean } }>();
    expect(body.role.name).toBe("editor");
  });

  it("POST role → 409 on duplicate name in same app", async () => {
    const seeded = await seedApp("app-dup-role");
    await seedRole(seeded.id, "editor");
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/roles`,
      payload: { name: "editor" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("PERM_004");
  });

  it("POST role → new isDefault demotes existing default", async () => {
    const seeded = await seedApp("app-default-role");
    await seedRole(seeded.id, "user", true);

    asAdmin();
    await app.inject({
      method: "POST",
      url: `/applications/${seeded.id}/roles`,
      payload: { name: "member", isDefault: true },
    });

    const roles = await db
      .select()
      .from(appRoles)
      .where(eq(appRoles.applicationId, seeded.id));

    const user = roles.find((r) => r.name === "user");
    const member = roles.find((r) => r.name === "member");
    expect(user?.isDefault).toBe(false);
    expect(member?.isDefault).toBe(true);
  });

  it("DELETE role → 400 when role is assigned to users", async () => {
    const seeded = await seedApp("app-del-assigned");
    const role = await seedRole(seeded.id, "assigned-role");

    // Seed a user and assign the role
    await db.insert(userTable).values({
      id: "u1",
      name: "U",
      email: "u@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(userAppRoles).values({
      userId: "u1",
      applicationId: seeded.id,
      roleId: role.id,
    });

    asAdmin();
    const res = await app.inject({
      method: "DELETE",
      url: `/applications/${seeded.id}/roles/${role.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("PERM_006");
  });

  it("DELETE role → 204 when role has no users", async () => {
    const seeded = await seedApp("app-del-unused");
    const role = await seedRole(seeded.id, "unused-role");

    asAdmin();
    const res = await app.inject({
      method: "DELETE",
      url: `/applications/${seeded.id}/roles/${role.id}`,
    });
    expect(res.statusCode).toBe(204);
  });
});
