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
import {
  applications,
  appPermissions,
  appRolePermissions,
  appRoles,
  userAppRoles,
} from "../db/schema.js";
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
    makeSuperadminSession() as unknown as SessionLike,
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

  describe("PATCH role", () => {
    it("updates the description and keeps the name", async () => {
      const seeded = await seedApp("app-patch-desc");
      const role = await seedRole(seeded.id, "editor");
      asAdmin();
      const res = await app.inject({
        method: "PATCH",
        url: `/applications/${seeded.id}/roles/${role.id}`,
        payload: { description: "Can edit content" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        role: { name: string; description: string | null };
      }>();
      expect(body.role.name).toBe("editor");
      expect(body.role.description).toBe("Can edit content");
    });

    it("clears the description with null", async () => {
      const seeded = await seedApp("app-patch-clear");
      const role = await seedRole(seeded.id, "editor");
      await db
        .update(appRoles)
        .set({ description: "old" })
        .where(eq(appRoles.id, role.id));
      asAdmin();
      const res = await app.inject({
        method: "PATCH",
        url: `/applications/${seeded.id}/roles/${role.id}`,
        payload: { description: null },
      });
      expect(res.statusCode).toBe(200);
      expect(
        res.json<{ role: { description: string | null } }>().role.description,
      ).toBeNull();
    });

    it("rejects a rename and leaves the role untouched", async () => {
      const seeded = await seedApp("app-patch-rename");
      const role = await seedRole(seeded.id, "editor");
      asAdmin();
      const res = await app.inject({
        method: "PATCH",
        url: `/applications/${seeded.id}/roles/${role.id}`,
        payload: { name: "root" },
      });
      expect(res.statusCode).toBe(400);
      const [row] = await db
        .select({ name: appRoles.name })
        .from(appRoles)
        .where(eq(appRoles.id, role.id));
      expect(row?.name).toBe("editor");
    });

    it("rejects an empty payload", async () => {
      const seeded = await seedApp("app-patch-empty");
      const role = await seedRole(seeded.id, "editor");
      asAdmin();
      const res = await app.inject({
        method: "PATCH",
        url: `/applications/${seeded.id}/roles/${role.id}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("404 for a role of another application", async () => {
      const first = await seedApp("app-patch-a");
      const second = await seedApp("app-patch-b");
      const role = await seedRole(first.id, "editor");
      asAdmin();
      const res = await app.inject({
        method: "PATCH",
        url: `/applications/${second.id}/roles/${role.id}`,
        payload: { description: "x" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        "PERM_002",
      );
    });

    it("promoting a role to default demotes the previous one", async () => {
      const seeded = await seedApp("app-patch-default");
      const previous = await seedRole(seeded.id, "user", true);
      const next = await seedRole(seeded.id, "member");
      asAdmin();
      const res = await app.inject({
        method: "PATCH",
        url: `/applications/${seeded.id}/roles/${next.id}`,
        payload: { isDefault: true },
      });
      expect(res.statusCode).toBe(200);
      const rows = await db
        .select({ id: appRoles.id, isDefault: appRoles.isDefault })
        .from(appRoles)
        .where(eq(appRoles.applicationId, seeded.id));
      expect(rows.find((r) => r.id === previous.id)?.isDefault).toBe(false);
      expect(rows.find((r) => r.id === next.id)?.isDefault).toBe(true);
    });
  });

  describe("role ↔ permission assignment", () => {
    async function seedPermission(appId: string, resource = "documents") {
      const [perm] = await db
        .insert(appPermissions)
        .values({ applicationId: appId, resource, action: "read" })
        .returning();
      return perm!;
    }

    it("assigns then unassigns a permission, reflected by GET roles", async () => {
      const seeded = await seedApp("app-assign");
      const role = await seedRole(seeded.id, "editor");
      const perm = await seedPermission(seeded.id);
      asAdmin();

      const assign = await app.inject({
        method: "POST",
        url: `/applications/${seeded.id}/roles/${role.id}/permissions`,
        payload: { permissionId: perm.id },
      });
      expect(assign.statusCode).toBe(201);

      // Idempotent: a second assignment is not an error.
      const again = await app.inject({
        method: "POST",
        url: `/applications/${seeded.id}/roles/${role.id}/permissions`,
        payload: { permissionId: perm.id },
      });
      expect(again.statusCode).toBe(201);

      const listed = await app.inject({
        method: "GET",
        url: `/applications/${seeded.id}/roles`,
      });
      expect(
        listed.json<{ roles: Array<{ permissionIds: string[] }> }>().roles[0]
          ?.permissionIds,
      ).toEqual([perm.id]);

      const unassign = await app.inject({
        method: "DELETE",
        url: `/applications/${seeded.id}/roles/${role.id}/permissions/${perm.id}`,
      });
      expect(unassign.statusCode).toBe(204);

      const after = await app.inject({
        method: "GET",
        url: `/applications/${seeded.id}/roles`,
      });
      expect(
        after.json<{ roles: Array<{ permissionIds: string[] }> }>().roles[0]
          ?.permissionIds,
      ).toEqual([]);
    });

    it("400 when permissionId is not a uuid", async () => {
      const seeded = await seedApp("app-assign-bad");
      const role = await seedRole(seeded.id, "editor");
      asAdmin();
      const res = await app.inject({
        method: "POST",
        url: `/applications/${seeded.id}/roles/${role.id}/permissions`,
        payload: { permissionId: "nope" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("404 PERM_003 when the permission belongs to another application", async () => {
      const first = await seedApp("app-assign-a");
      const second = await seedApp("app-assign-b");
      const role = await seedRole(first.id, "editor");
      const foreign = await seedPermission(second.id);
      asAdmin();
      const res = await app.inject({
        method: "POST",
        url: `/applications/${first.id}/roles/${role.id}/permissions`,
        payload: { permissionId: foreign.id },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        "PERM_003",
      );
      const rows = await db.select().from(appRolePermissions);
      expect(rows).toHaveLength(0);
    });

    it("404 PERM_002 when the role belongs to another application", async () => {
      const first = await seedApp("app-assign-c");
      const second = await seedApp("app-assign-d");
      const foreignRole = await seedRole(second.id, "editor");
      const perm = await seedPermission(first.id);
      asAdmin();
      const res = await app.inject({
        method: "POST",
        url: `/applications/${first.id}/roles/${foreignRole.id}/permissions`,
        payload: { permissionId: perm.id },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        "PERM_002",
      );
    });

    it("cannot unassign through another application's URL", async () => {
      const first = await seedApp("app-assign-e");
      const second = await seedApp("app-assign-f");
      const role = await seedRole(first.id, "editor");
      const perm = await seedPermission(first.id);
      await db
        .insert(appRolePermissions)
        .values({ roleId: role.id, permissionId: perm.id });
      asAdmin();
      const res = await app.inject({
        method: "DELETE",
        url: `/applications/${second.id}/roles/${role.id}/permissions/${perm.id}`,
      });
      expect(res.statusCode).toBe(404);
      const rows = await db.select().from(appRolePermissions);
      expect(rows).toHaveLength(1);
    });
  });
});
