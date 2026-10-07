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
import { applicationRoutes } from "../routes/admin/applications.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import {
  applications,
  appRoles,
  subscriptionPlans,
  userApplications,
  userAppRoles,
  userSubscriptions,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeAdminSession, makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
// `generateId` feeds the `oauth_client` primary key, so a constant would make a
// test that creates two applications collide on that key.
let generatedIds = 0;
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof BetterAuthModule>();
  return { ...actual, generateId: vi.fn(() => `mock-oauth-id-${++generatedIds}`) };
});

// ── App ────────────────────────────────────────────────────────────────────

const app = createTestApp();

beforeAll(async () => {
  await app.register(applicationRoutes);
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

async function createApp(slug = "test-app") {
  asAdmin();
  const res = await app.inject({
    method: "POST",
    url: "/",
    payload: {
      name: "Test App",
      slug,
      isPublic: false,
    },
  });
  return res;
}

/** Create an application as the given session and return the created row id. */
async function createAppAs(
  session: SessionLike,
  slug: string,
): Promise<string> {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(session);
  const res = await app.inject({
    method: "POST",
    url: "/",
    payload: { name: "Test App", slug, isPublic: false },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ application: { id: string } }>().application.id;
}

function asSession(session: ReturnType<typeof makeAdminSession>) {
  return session as unknown as SessionLike;
}

/** Seed a global-role user row so it can be the caller of a request. */
async function seedUser(id: string, role: string, email = `${id}@example.com`) {
  await db.insert(userTable).values({
    id,
    name: id,
    email,
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("applicationRoutes integration", () => {
  it("401 when not authenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("GET / → returns empty list initially", async () => {
    asAdmin();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ applications: unknown[] }>();
    expect(body.applications).toHaveLength(0);
  });

  it("POST / → creates an application with default roles and plan", async () => {
    const res = await createApp("my-app");
    expect(res.statusCode).toBe(201);
    const body = res.json<{ application: { id: string; slug: string }; clientId: string; clientSecret: string }>();
    expect(body.application.slug).toBe("my-app");
    expect(body.clientId).toBe("my-app");
    expect(body.clientSecret).toBeTruthy();

    // Verify default roles were created
    const roles = await db
      .select()
      .from(appRoles)
      .where(eq(appRoles.applicationId, body.application.id));
    expect(roles).toHaveLength(2);
    const roleNames = roles.map((r) => r.name).sort();
    expect(roleNames).toEqual(["admin", "user"]);
    expect(roles.find((r) => r.name === "user")?.isDefault).toBe(true);

    // Verify default plan was created
    const plans = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.applicationId, body.application.id));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.name).toBe("free");
    expect(plans[0]!.isDefault).toBe(true);
  });

  it("POST / → 409 on duplicate slug", async () => {
    await createApp("dup-slug");
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { name: "Another", slug: "dup-slug" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("APP_003");
  });

  it("POST / → public app has no clientSecret", async () => {
    asAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { name: "Public App", slug: "pub-app", isPublic: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ clientSecret?: string }>();
    expect(body.clientSecret).toBeUndefined();
  });

  it("POST / auto-assigns superadmins to new app", async () => {
    // Seed a superadmin and make it the creator, as a real caller always is.
    await seedUser("sa-1", "superadmin", "sa@example.com");

    const appId = await createAppAs(
      asSession(makeSuperadminSession("sa-1")),
      "sa-app",
    );

    // The superadmin should have access to the app
    const access = await db
      .select()
      .from(userApplications)
      .where(eq(userApplications.applicationId, appId));
    expect(access).toHaveLength(1);
    expect(access[0]!.userId).toBe("sa-1");
    expect(access[0]!.isActive).toBe(true);
  });

  it("POST / → the superadmin creator is attached exactly once", async () => {
    // The creator is itself a superadmin, so it is listed by the superadmin
    // query AND added as creator: the two must collapse into one set of rows.
    await seedUser("sa-1", "superadmin", "sa@example.com");
    const appId = await createAppAs(
      asSession(makeSuperadminSession("sa-1")),
      "sa-self",
    );

    const access = await db
      .select()
      .from(userApplications)
      .where(eq(userApplications.applicationId, appId));
    const roles = await db
      .select()
      .from(userAppRoles)
      .where(eq(userAppRoles.applicationId, appId));
    const subs = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.applicationId, appId));

    expect(access).toHaveLength(1);
    expect(roles).toHaveLength(1);
    expect(subs).toHaveLength(1);
    expect(access[0]!.userId).toBe("sa-1");
  });

  it("POST / → attaches the admin creator with the app admin role and free plan", async () => {
    await seedUser("admin-1", "admin");

    const appId = await createAppAs(
      asSession(makeAdminSession("admin-1")),
      "admin-app",
    );

    const [freePlan] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.applicationId, appId));

    // Access row: active, on the free plan.
    const access = await db
      .select()
      .from(userApplications)
      .where(eq(userApplications.applicationId, appId));
    expect(access).toHaveLength(1);
    expect(access[0]!.userId).toBe("admin-1");
    expect(access[0]!.isActive).toBe(true);
    expect(access[0]!.subscriptionPlanId).toBe(freePlan!.id);

    // Application role: the `admin` one, not the default `user`.
    const roles = await db
      .select({ name: appRoles.name })
      .from(userAppRoles)
      .innerJoin(appRoles, eq(userAppRoles.roleId, appRoles.id))
      .where(eq(userAppRoles.applicationId, appId));
    expect(roles).toHaveLength(1);
    expect(roles[0]!.name).toBe("admin");

    // Subscription: the free plan.
    const subs = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.applicationId, appId));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.userId).toBe("admin-1");
    expect(subs[0]!.planId).toBe(freePlan!.id);
  });

  it("POST / → an admin creator is admin only on the application it created", async () => {
    await seedUser("admin-1", "admin");
    await seedUser("sa-1", "superadmin", "sa@example.com");

    const ownAppId = await createAppAs(
      asSession(makeAdminSession("admin-1")),
      "admin-own-app",
    );
    // Someone else creates a second application.
    const otherAppId = await createAppAs(
      asSession(makeSuperadminSession("sa-1")),
      "other-app",
    );

    // Exactly one application role row exists for this admin, on its own app.
    const roleRows = await db
      .select({ applicationId: userAppRoles.applicationId })
      .from(userAppRoles)
      .where(eq(userAppRoles.userId, "admin-1"));
    expect(roleRows).toHaveLength(1);
    expect(roleRows[0]!.applicationId).toBe(ownAppId);

    // Nothing leaked onto the application it did not create.
    const accessRows = await db
      .select({ applicationId: userApplications.applicationId })
      .from(userApplications)
      .where(eq(userApplications.userId, "admin-1"));
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]!.applicationId).toBe(ownAppId);
    expect(otherAppId).not.toBe(ownAppId);
  });

  it("DELETE /:id → removes the application", async () => {
    const createRes = await createApp("to-delete");
    const appId = createRes.json<{ application: { id: string } }>().application.id;

    asAdmin();
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/${appId}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    // Verify gone
    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.id, appId));
    expect(rows).toHaveLength(0);
  });

  it("GET /:id → 404 for unknown application", async () => {
    asAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});
