/**
 * Integration tests for the two bulk admin actions:
 *  - POST /api/admin/users/import          (CSV rows sent as JSON)
 *  - POST /api/admin/applications/:id/users/bulk (grant by organization)
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type * as BetterAuthModule from "better-auth";
import { usersRoutes } from "../routes/admin/users.js";
import { applicationRoutes } from "../routes/admin/applications.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { userApplications, appRoles, userAppRoles } from "../db/schema.js";
import { user as userTable, organization, member } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeAdminSession, makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof BetterAuthModule>();
  return { ...actual, generateId: vi.fn(() => "mock-id") };
});

const usersApp = createTestApp();
const appsApp = createTestApp();

beforeAll(async () => {
  await usersApp.register(usersRoutes);
  await usersApp.ready();
  await appsApp.register(applicationRoutes);
  await appsApp.ready();
});

afterAll(async () => {
  await usersApp.close();
  await appsApp.close();
});

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

type SessionLike = ReturnType<typeof auth.api.getSession> extends Promise<
  infer T
>
  ? T
  : never;

function asSuperadmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession() as unknown as SessionLike,
  );
}

async function seedUser(id: string, email: string) {
  await db.insert(userTable).values({
    id,
    name: `User ${id}`,
    email,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("bulk actions integration", () => {
  it("imports users and returns generated passwords", async () => {
    asSuperadmin();
    const createUser = vi
      .spyOn(auth.api, "createUser")
      .mockResolvedValue({ user: { id: "u-new" } } as never);
    vi.spyOn(auth.api, "sendVerificationEmail").mockResolvedValue(
      {} as never,
    );

    const res = await usersApp.inject({
      method: "POST",
      url: "/import",
      payload: {
        users: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com", password: "bob-secret-1" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      created: number;
      failed: number;
      results: Array<{ email: string; status: string; password?: string }>;
    }>();
    expect(body.created).toBe(2);
    expect(body.failed).toBe(0);
    // Only the row without an explicit password gets a generated one.
    expect(body.results.find((r) => r.email === "alice@example.com")?.password)
      .toBeTruthy();
    expect(body.results.find((r) => r.email === "bob@example.com")?.password)
      .toBeUndefined();
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it("refuses admin rows when the caller is not a superadmin", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      makeAdminSession() as unknown as SessionLike,
    );
    const createUser = vi
      .spyOn(auth.api, "createUser")
      .mockResolvedValue({ user: { id: "u" } } as never);

    const res = await usersApp.inject({
      method: "POST",
      url: "/import",
      payload: {
        users: [
          { name: "Root", email: "root@example.com", role: "admin" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ failed: number }>().failed).toBe(1);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("grants access to every member of an organization", async () => {
    asSuperadmin();
    const createRes = await appsApp.inject({
      method: "POST",
      url: "/",
      payload: { name: "Bulk App", slug: "bulk-app", isPublic: false },
    });
    expect(createRes.statusCode).toBe(201);
    const appId = createRes.json<{ application: { id: string } }>().application
      .id;

    await seedUser("u1", "u1@example.com");
    await seedUser("u2", "u2@example.com");
    await db.insert(organization).values({
      id: "org-1",
      name: "Org",
      slug: "org-1",
      createdAt: new Date(),
    });
    await db.insert(member).values([
      {
        id: "m1",
        organizationId: "org-1",
        userId: "u1",
        role: "member",
        createdAt: new Date(),
      },
      {
        id: "m2",
        organizationId: "org-1",
        userId: "u2",
        role: "member",
        createdAt: new Date(),
      },
    ]);

    const res = await appsApp.inject({
      method: "POST",
      url: `/${appId}/users/bulk`,
      payload: { organizationId: "org-1" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ granted: number }>().granted).toBe(2);

    const rows = await db
      .select({ userId: userApplications.userId })
      .from(userApplications)
      .where(eq(userApplications.applicationId, appId));
    expect(rows.map((r) => r.userId).sort()).toEqual(["u1", "u2"]);

    // Re-running the same bulk grant must not duplicate anything.
    const again = await appsApp.inject({
      method: "POST",
      url: `/${appId}/users/bulk`,
      payload: { organizationId: "org-1" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ granted: number; skipped: number }>()).toMatchObject({
      granted: 0,
      skipped: 2,
    });
    const rowsAfter = await db
      .select({ userId: userApplications.userId })
      .from(userApplications)
      .where(eq(userApplications.applicationId, appId));
    expect(rowsAfter).toHaveLength(2);
  });

  it("lists one row per user even when they hold several roles", async () => {
    asSuperadmin();
    const createRes = await appsApp.inject({
      method: "POST",
      url: "/",
      payload: { name: "Multi Role App", slug: "multi-role-app", isPublic: false },
    });
    const appId = createRes.json<{ application: { id: string } }>().application
      .id;

    await seedUser("u1", "u1@example.com");
    await db.insert(appRoles).values([
      {
        id: "11111111-1111-1111-1111-111111111111",
        applicationId: appId,
        name: "Role A",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        applicationId: appId,
        name: "Role B",
      },
    ]);
    await db.insert(userAppRoles).values([
      {
        userId: "u1",
        applicationId: appId,
        roleId: "11111111-1111-1111-1111-111111111111",
      },
      {
        userId: "u1",
        applicationId: appId,
        roleId: "22222222-2222-2222-2222-222222222222",
      },
    ]);
    await db.insert(userApplications).values({
      userId: "u1",
      applicationId: appId,
      isActive: true,
    });

    const res = await appsApp.inject({ method: "GET", url: `/${appId}/users` });
    expect(res.statusCode).toBe(200);
    const users = res.json<{ users: Array<{ userId: string }> }>().users;
    expect(users.filter((u) => u.userId === "u1")).toHaveLength(1);
  });
});
