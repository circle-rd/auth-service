import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { applicationRoutes } from "../routes/admin/applications.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { applications, appRoles, subscriptionPlans } from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  return { ...actual, generateId: vi.fn(() => "mock-oauth-id") };
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
    makeSuperadminSession() as SessionLike,
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
    // Seed a superadmin
    await db.insert(userTable).values({
      id: "sa-1",
      name: "Super Admin",
      email: "sa@example.com",
      emailVerified: true,
      role: "superadmin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await createApp("sa-app");
    expect(res.statusCode).toBe(201);
    const body = res.json<{ application: { id: string } }>();
    const appId = body.application.id;

    // The superadmin should have access to the app
    const { userApplications } = await import("../db/schema.js");
    const access = await db
      .select()
      .from(userApplications)
      .where(eq(userApplications.applicationId, appId));
    expect(access).toHaveLength(1);
    expect(access[0]!.userId).toBe("sa-1");
    expect(access[0]!.isActive).toBe(true);
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
