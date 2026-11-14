import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  appDelegations,
  appRoles,
  resourceGrants,
  resourceInvitations,
  sharedResources,
  subscriptionPlans,
  userApplications,
  userAppRoles,
} from "../db/schema.js";
import { config } from "../config.js";
import { extractUrl } from "./helpers/email-capture.js";

let handle: AuthServerHandle;
let adminCookie: string;
let ownerACookie: string;
let ownerBCookie: string;
let userCCookie: string;
let appA: { id: string; slug: string; url: string; planId: string; roleId: string };
let appB: { id: string; slug: string; url: string; planId: string; roleId: string };
let userCId: string;

async function signInAdmin(): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email: "admin-owner@example.test",
    password: "Password123!",
    name: "Admin",
  });
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "admin-owner@example.test"));
  return cookie;
}

async function createApp(opts: {
  slug: string;
  url: string;
}): Promise<{ id: string; slug: string; url: string; planId: string; roleId: string }> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: {
      name: opts.slug,
      slug: opts.slug,
      url: opts.url,
      redirectUris: [`${opts.url}/callback`],
      isPublic: false,
      allowedScopes: ["openid", "profile", "email"],
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { application: { id: string } };
  const plans = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, body.application.id));
  const roles = await db
    .select({ id: appRoles.id, name: appRoles.name })
    .from(appRoles)
    .where(eq(appRoles.applicationId, body.application.id));
  const adminRole = roles.find((role) => role.name === "admin");
  if (!plans[0] || !adminRole) throw new Error("application defaults missing");
  return {
    id: body.application.id,
    slug: opts.slug,
    url: opts.url,
    planId: plans[0].id,
    roleId: adminRole.id,
  };
}

async function assignAdminRole(userId: string, app: { id: string; roleId: string }): Promise<void> {
  await db
    .insert(userApplications)
    .values({ userId, applicationId: app.id, isActive: true })
    .onConflictDoNothing();
  await db
    .insert(userAppRoles)
    .values({ userId, applicationId: app.id, roleId: app.roleId })
    .onConflictDoNothing();
}

async function userIdFor(email: string): Promise<string> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email));
  if (!row) throw new Error("user missing");
  return row.id;
}

function req(
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return handle.app.inject({
    method,
    url,
    remoteAddress: "203.0.113.7",
    headers: {
      cookie,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

async function createResource(
  cookie: string,
  appId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const res = await req(cookie, "POST", `/api/user/apps/${appId}/shared-resources`, {
    resourceType: "model",
    slug: "model-a",
    displayName: "Model A",
    ...body,
  });
  expect(res.statusCode).toBe(201);
  const parsed = res.json() as { resource: { id: string; key: string } };
  return parsed.resource;
}

beforeAll(async () => {
  await cleanDb();
  handle = await makeAuthServer();
  adminCookie = await signInAdmin();
  appA = await createApp({ slug: "app-a", url: "https://app-a.example.test" });
  appB = await createApp({ slug: "app-b", url: "https://app-b.example.test" });

  ({ cookie: ownerACookie } = await signUpAndSignIn(handle, {
    email: "owner-a@example.test",
    password: "Password123!",
    name: "Owner A",
  }));
  ({ cookie: ownerBCookie } = await signUpAndSignIn(handle, {
    email: "owner-b@example.test",
    password: "Password123!",
    name: "Owner B",
  }));
  ({ cookie: userCCookie } = await signUpAndSignIn(handle, {
    email: "invitee-c@example.test",
    password: "Password123!",
    name: "Invitee C",
  }));
  userCId = await userIdFor("invitee-c@example.test");

  await assignAdminRole(await userIdFor("owner-a@example.test"), appA);
  await assignAdminRole(await userIdFor("owner-b@example.test"), appB);
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  handle.capture.clear();
  await db.delete(resourceInvitations);
  await db.delete(resourceGrants);
  await db.delete(sharedResources);
});

describe("owner delegation and cross-tenant isolation (AC-04)", () => {
  it("rejects unauthenticated owner and catalogue requests", async () => {
    const list = await handle.app.inject({
      method: "GET",
      url: `/api/user/apps/${appA.id}/shared-resources`,
    });
    expect(list.statusCode).toBe(401);
    expect(list.json()).toMatchObject({ error: { code: "AUTH_001" } });

    const catalogue = await handle.app.inject({
      method: "GET",
      url: "/api/user/accessible-resources?clientId=app-c",
    });
    expect(catalogue.statusCode).toBe(401);
  });

  it("lets the built-in app admin role administer its own app", async () => {
    const resource = await createResource(ownerACookie, appA.id, {});
    const list = await req(ownerACookie, "GET", `/api/user/apps/${appA.id}/shared-resources`);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { resources: { id: string }[] }).resources).toEqual([
      expect.objectContaining({ id: resource.id }),
    ]);
  });

  it("answers another app's resources with the same 404 as a missing resource", async () => {
    const resource = await createResource(ownerACookie, appA.id, {});
    const foreign = await req(
      ownerBCookie,
      "GET",
      `/api/user/apps/${appA.id}/shared-resources`,
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: { code: "RES_004" } });

    const missing = await req(
      ownerBCookie,
      "GET",
      "/api/user/apps/99999999-9999-4999-8999-999999999999/shared-resources",
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());

    const readForeignResource = await req(
      ownerBCookie,
      "GET",
      `/api/user/apps/${appB.id}/shared-resources/${resource.id}`,
    );
    const readMissingResource = await req(
      ownerBCookie,
      "GET",
      `/api/user/apps/${appB.id}/shared-resources/99999999-9999-4999-8999-999999999999`,
    );
    expect(readForeignResource.statusCode).toBe(404);
    expect(readForeignResource.json()).toEqual(readMissingResource.json());
  });

  it("rejects a member without the owner role and honours explicit delegation", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "member-a@example.test",
      password: "Password123!",
      name: "Member A",
    });
    const memberId = await userIdFor("member-a@example.test");
    await db
      .insert(userApplications)
      .values({ userId: memberId, applicationId: appA.id, isActive: true });

    expect(
      (
        await req(cookie, "GET", `/api/user/apps/${appA.id}/shared-resources`)
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await req(cookie, "POST", `/api/user/apps/${appA.id}/shared-resources`, {
          resourceType: "model",
          slug: "model-member",
          displayName: "Member",
        })
      ).statusCode,
    ).toBe(404);

    await db.insert(appDelegations).values({
      userId: memberId,
      applicationId: appA.id,
      permission: "resources:read",
      status: "active",
    });
    expect(
      (
        await req(cookie, "GET", `/api/user/apps/${appA.id}/shared-resources`)
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await req(cookie, "POST", `/api/user/apps/${appA.id}/shared-resources`, {
          resourceType: "model",
          slug: "model-member",
          displayName: "Member",
        })
      ).statusCode,
    ).toBe(404);

    await db.insert(appDelegations).values({
      userId: memberId,
      applicationId: appA.id,
      permission: "grants:manage",
      status: "active",
    });
    expect(
      (
        await req(cookie, "GET", `/api/user/apps/${appA.id}/grants`)
      ).statusCode,
    ).toBe(200);
  });
});

describe("owner resource CRUD", () => {
  it("creates, reads, patches and soft-deletes without removing the row", async () => {
    const resource = await createResource(ownerACookie, appA.id, {
      status: "published",
    });
    const read = await req(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/shared-resources/${resource.id}`,
    );
    expect(read.statusCode).toBe(200);

    const patched = await req(
      ownerACookie,
      "PATCH",
      `/api/user/apps/${appA.id}/shared-resources/${resource.id}`,
      { displayName: "Renamed" },
    );
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { resource: { displayName: string } }).resource.displayName).toBe(
      "Renamed",
    );

    const deleted = await req(
      ownerACookie,
      "DELETE",
      `/api/user/apps/${appA.id}/shared-resources/${resource.id}`,
    );
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { resource: { status: string } }).resource.status).toBe(
      "disabled",
    );

    const [row] = await db
      .select({ status: sharedResources.status, key: sharedResources.key })
      .from(sharedResources)
      .where(eq(sharedResources.id, resource.id));
    expect(row).toEqual({ status: "disabled", key: resource.key });
  });

  it("rejects malformed and cross-app plans", async () => {
    const invalid = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/shared-resources`,
      { resourceType: "ssh_host", slug: "model-x", displayName: "X" },
    );
    expect(invalid.statusCode).toBe(400);

    const foreignPlan = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/shared-resources`,
      {
        resourceType: "model",
        slug: "model-plan",
        displayName: "Plan",
        defaultPlanId: appB.planId,
      },
    );
    expect(foreignPlan.statusCode).toBe(400);
    expect(foreignPlan.json()).toMatchObject({ error: { code: "RES_001" } });
  });
});

describe("owner grants and invitations", () => {
  it("invites an existing account and creates the grant on acceptance", async () => {
    const resource = await createResource(ownerACookie, appA.id, {
      status: "published",
    });
    const invitation = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/invitations`,
      {
        email: "invitee-c@example.test",
        planId: appA.planId,
        resourceId: resource.id,
      },
    );
    expect(invitation.statusCode).toBe(201);
    expect((invitation.json() as { emailSent: boolean }).emailSent).toBe(true);

    const mail = handle.capture.last("invitee-c@example.test");
    if (!mail) throw new Error("invitation email missing");
    const token = new URL(extractUrl(mail.html, (u) => u.includes("resource-invitation"))).searchParams.get(
      "token",
    );
    expect(token).toBeTruthy();

    const accepted = await req(userCCookie, "POST", "/api/user/resource-invitations/accept", {
      token,
    });
    expect(accepted.statusCode).toBe(200);

    const [grant] = await db
      .select()
      .from(resourceGrants)
      .where(eq(resourceGrants.subjectId, userCId));
    expect(grant).toMatchObject({
      ownerApplicationId: appA.id,
      resourceId: resource.id,
      planId: appA.planId,
    });

    const catalogue = await req(
      userCCookie,
      "GET",
      "/api/user/accessible-resources?clientId=app-c&resourceType=model",
    );
    expect(catalogue.statusCode).toBe(200);
    expect((catalogue.json() as { resources: { resourceId: string }[] }).resources).toEqual([
      expect.objectContaining({ resourceId: resource.id }),
    ]);
  });

  it("rejects expired, revoked and reused invitations without creating grants", async () => {
    const invitation = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/invitations`,
      { email: "invitee-c@example.test", planId: appA.planId, ttlHours: 1 },
    );
    expect(invitation.statusCode).toBe(201);
    const token = new URL((invitation.json() as { inviteUrl: string }).inviteUrl).searchParams.get(
      "token",
    ) as string;
    await db
      .update(resourceInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(resourceInvitations.ownerApplicationId, appA.id));
    expect(
      (await req(userCCookie, "POST", "/api/user/resource-invitations/accept", { token }))
        .statusCode,
    ).toBe(400);

    await db.delete(resourceInvitations);
    const revoked = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/invitations`,
      { email: "invitee-c@example.test", planId: appA.planId },
    );
    const revokedToken = new URL(
      (revoked.json() as { inviteUrl: string }).inviteUrl,
    ).searchParams.get("token") as string;
    await db
      .update(resourceInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(resourceInvitations.ownerApplicationId, appA.id));
    expect(
      (
        await req(userCCookie, "POST", "/api/user/resource-invitations/accept", {
          token: revokedToken,
        })
      ).statusCode,
    ).toBe(400);

    expect(await db.select().from(resourceGrants)).toHaveLength(0);
    expect(await db.select().from(resourceInvitations)).toHaveLength(1);
    expect(
      (await db.select().from(resourceInvitations))[0]?.revokedAt,
    ).toBeInstanceOf(Date);
  });

  it("rejects an invitation for a plan or resource of another app", async () => {
    const resource = await createResource(ownerACookie, appA.id, {});
    const foreignPlan = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/invitations`,
      { email: "invitee-c@example.test", planId: appB.planId },
    );
    expect(foreignPlan.statusCode).toBe(400);
    expect(foreignPlan.json()).toMatchObject({ error: { code: "RES_001" } });

    const foreignResource = await req(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/invitations`,
      {
        email: "invitee-c@example.test",
        planId: appA.planId,
        resourceId: "99999999-9999-4999-8999-999999999999",
      },
    );
    expect(foreignResource.statusCode).toBe(404);
    expect(foreignResource.json()).toMatchObject({ error: { code: "RES_002" } });
    expect(resource.id).toBeTruthy();
  });

  it("narrows and revokes a grant through the owner API", async () => {
    const resource = await createResource(ownerACookie, appA.id, {
      status: "published",
    });
    const { createResourceInvitation } = await import(
      "../services/resource-sharing/invitations.js"
    );
    const invitation = await createResourceInvitation({
      email: "invitee-c@example.test",
      ownerApplicationId: appA.id,
      planId: appA.planId,
      resourceId: resource.id,
      createdBy: "owner-a",
    });
    const token = invitation.token;
    expect(
      (await req(userCCookie, "POST", "/api/user/resource-invitations/accept", { token }))
        .statusCode,
    ).toBe(200);
    const [grant] = await db
      .select()
      .from(resourceGrants)
      .where(eq(resourceGrants.subjectId, userCId));

    const updated = await req(
      ownerACookie,
      "PUT",
      `/api/user/apps/${appA.id}/grants/${grant!.id}`,
      {
        allowedClientIds: ["app-c"],
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    );
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { grant: { allowedClientIds: string[] } }).grant.allowedClientIds).toEqual(
      ["app-c"],
    );

    const revoked = await req(
      ownerACookie,
      "DELETE",
      `/api/user/apps/${appA.id}/grants/${grant!.id}`,
    );
    expect(revoked.statusCode).toBe(200);

    const foreignApp = await req(
      ownerBCookie,
      "DELETE",
      `/api/user/apps/${appB.id}/grants/${grant!.id}`,
    );
    expect(foreignApp.statusCode).toBe(404);
    expect(foreignApp.json()).toMatchObject({ error: { code: "RES_007" } });
  });

  it("rejects a foreign plan or resource on grant update", async () => {
    const resource = await createResource(ownerACookie, appA.id, {
      status: "published",
    });
    await db.insert(resourceGrants).values({
      subjectId: userCId,
      ownerApplicationId: appA.id,
      resourceId: resource.id,
      planId: appA.planId,
      createdBy: "owner-a",
    });
    const [grant] = await db
      .select()
      .from(resourceGrants)
      .where(eq(resourceGrants.subjectId, userCId));

    expect(
      (
        await req(ownerACookie, "PUT", `/api/user/apps/${appA.id}/grants/${grant!.id}`, {
          planId: appB.planId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await req(ownerACookie, "PUT", `/api/user/apps/${appA.id}/grants/${grant!.id}`, {
          resourceId: "99999999-9999-4999-8999-999999999999",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("rate-limits invitation email at the existing bucket, not owner writes", async () => {
    const results = [];
    for (let index = 0; index < 6; index++) {
      results.push(
        await req(ownerACookie, "POST", `/api/user/apps/${appA.id}/invitations`, {
          email: `invitee-${index}@example.test`,
          planId: appA.planId,
        }),
      );
    }
    expect(results.some((res) => res.statusCode === 429)).toBe(true);
    const list = await req(ownerACookie, "GET", `/api/user/apps/${appA.id}/shared-resources`);
    expect(list.statusCode).toBe(200);
  });
});

describe("feature flag", () => {
  it("does not mount owner APIs when RESOURCE_SHARING_ENABLED is false", async () => {
    const previous = config.features.resourceSharing;
    (config.features as { resourceSharing: boolean }).resourceSharing = false;
    const disabled = await makeAuthServer();
    try {
      const res = await disabled.app.inject({
        method: "GET",
        url: `/api/user/apps/${appA.id}/shared-resources`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await disabled.cleanup();
      (config.features as { resourceSharing: boolean }).resourceSharing = previous;
    }
  });
});
