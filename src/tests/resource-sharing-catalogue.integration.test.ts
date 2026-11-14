import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  resourceGrants,
  sharedResources,
  subscriptionPlans,
  userApplications,
} from "../db/schema.js";

let handle: AuthServerHandle;
let adminCookie: string;
let subjectCookie: string;
let otherCookie: string;
let subjectId: string;
let otherId: string;
let appA: { id: string; planId: string };
let appB: { id: string; planId: string };

async function signInAdmin(): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email: "catalogue-admin@example.test",
    password: "Password123!",
    name: "Admin",
  });
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "catalogue-admin@example.test"));
  return cookie;
}

async function createApp(slug: string): Promise<{ id: string; planId: string }> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: {
      name: slug,
      slug,
      url: `https://${slug}.example.test`,
      redirectUris: [`https://${slug}.example.test/callback`],
      isPublic: false,
      allowedScopes: ["openid", "profile", "email"],
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { application: { id: string } };
  const [plan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, body.application.id));
  if (!plan) throw new Error("application default plan missing");
  return { id: body.application.id, planId: plan.id };
}

async function userIdFor(email: string): Promise<string> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email));
  if (!row) throw new Error("user missing");
  return row.id;
}

async function createResource(
  appId: string,
  slug: string,
  overrides: { status?: string; type?: string; displayName?: string } = {},
): Promise<string> {
  const type = overrides.type ?? "model";
  const [row] = await db
    .insert(sharedResources)
    .values({
      ownerApplicationId: appId,
      resourceType: type as "model",
      key: `${appId.slice(0, 8)}/${slug}`,
      displayName: overrides.displayName ?? slug,
      status: (overrides.status ?? "published") as "published",
    })
    .returning({ id: sharedResources.id });
  if (!row) throw new Error("resource insert failed");
  return row.id;
}

async function grant(
  input: {
    subjectId: string;
    app: { id: string; planId: string };
    resourceId: string;
    allowedClientIds?: string[] | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  },
): Promise<void> {
  await db.insert(resourceGrants).values({
    subjectId: input.subjectId,
    ownerApplicationId: input.app.id,
    resourceId: input.resourceId,
    planId: input.app.planId,
    allowedClientIds: input.allowedClientIds ?? null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: input.revokedAt ?? null,
    createdBy: "seed",
  });
}

async function catalogue(cookie: string) {
  return handle.app.inject({
    method: "GET",
    url: "/api/user/resource-catalogue",
    headers: { cookie },
  });
}

beforeAll(async () => {
  handle = await makeAuthServer();
  adminCookie = await signInAdmin();
  appA = await createApp("catalogue-app-a");
  appB = await createApp("catalogue-app-b");

  ({ cookie: subjectCookie } = await signUpAndSignIn(handle, {
    email: "catalogue-subject@example.test",
    password: "Password123!",
    name: "Subject",
  }));
  ({ cookie: otherCookie } = await signUpAndSignIn(handle, {
    email: "catalogue-other@example.test",
    password: "Password123!",
    name: "Other",
  }));
  subjectId = await userIdFor("catalogue-subject@example.test");
  otherId = await userIdFor("catalogue-other@example.test");
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await db
    .delete(userApplications)
    .where(inArray(userApplications.userId, [subjectId, otherId]));
  await db
    .update(subscriptionPlans)
    .set({ isDefault: true })
    .where(eq(subscriptionPlans.applicationId, appA.id));
  await db
    .update(subscriptionPlans)
    .set({ isDefault: true })
    .where(eq(subscriptionPlans.applicationId, appB.id));
  await db.delete(resourceGrants);
  await db.delete(sharedResources);
});

describe("GET /api/user/resource-catalogue", () => {
  it("requires a session", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/api/user/resource-catalogue",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "AUTH_001" } });
  });

  it("omits a published resource without a grant", async () => {
    await createResource(appA.id, "model-a");
    const res = await catalogue(subjectCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resources: [] });
  });

  it("omits revoked, expired, draft and disabled resources", async () => {
    const revoked = await createResource(appA.id, "revoked");
    const expired = await createResource(appA.id, "expired");
    await createResource(appA.id, "draft", { status: "draft" });
    await createResource(appA.id, "disabled", { status: "disabled" });
    await grant({ subjectId, app: appA, resourceId: revoked, revokedAt: new Date() });
    await grant({
      subjectId,
      app: appA,
      resourceId: expired,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await catalogue(subjectCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resources: [] });
  });

  it("omits membership access when no plan resolves", async () => {
    await createResource(appA.id, "no-plan");
    await db
      .update(subscriptionPlans)
      .set({ isDefault: false })
      .where(eq(subscriptionPlans.applicationId, appA.id));
    await db
      .insert(userApplications)
      .values({ userId: subjectId, applicationId: appA.id, isActive: true });

    const res = await catalogue(subjectCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resources: [] });
  });

  it("returns two owners' resources in one session with plan and client metadata", async () => {
    const a = await createResource(appA.id, "model-a", { displayName: "Model A" });
    const b = await createResource(appB.id, "model-b", { displayName: "Model B" });
    await grant({ subjectId, app: appA, resourceId: a });
    await grant({
      subjectId,
      app: appB,
      resourceId: b,
      allowedClientIds: ["client-b"],
    });

    const res = await catalogue(subjectCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resources: Array<{
        resourceId: string;
        ownerApplicationSlug: string;
        planName: string;
        restrictedToClientIds: string[] | null;
      }>;
    };
    expect(body.resources).toHaveLength(2);
    expect(body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: a,
          ownerApplicationSlug: "catalogue-app-a",
          planName: expect.any(String),
          restrictedToClientIds: null,
        }),
        expect.objectContaining({
          resourceId: b,
          ownerApplicationSlug: "catalogue-app-b",
          planName: expect.any(String),
          restrictedToClientIds: ["client-b"],
        }),
      ]),
    );
  });

  it("keeps subjects isolated from grants held by another account", async () => {
    const a = await createResource(appA.id, "model-a");
    const b = await createResource(appB.id, "model-b");
    await grant({ subjectId, app: appA, resourceId: a });
    await grant({ subjectId: otherId, app: appB, resourceId: b });

    const mine = await catalogue(subjectCookie);
    const theirs = await catalogue(otherCookie);
    expect(
      (mine.json() as { resources: Array<{ resourceId: string }> }).resources.map(
        (item) => item.resourceId,
      ),
    ).toEqual([a]);
    expect(
      (theirs.json() as { resources: Array<{ resourceId: string }> }).resources.map(
        (item) => item.resourceId,
      ),
    ).toEqual([b]);
  });
});
