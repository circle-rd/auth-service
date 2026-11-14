import { createHash } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { count, eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  appRoles,
  resourceGrants,
  resourceInvitations,
  sharedResources,
  subscriptionPlans,
  usageRecords,
  userApplications,
  userAppRoles,
  walletTransactions,
} from "../db/schema.js";
import { createSharedResource } from "../services/resource-sharing/registry.js";
import { createResourceGrant } from "../services/resource-sharing/grants.js";

let handle: AuthServerHandle;
let adminCookie: string;
let ownerACookie: string;
let ownerBCookie: string;
let appA: { id: string; slug: string; url: string; planId: string; planName: string; roleId: string };
let appB: { id: string; slug: string; url: string; planId: string; planName: string; roleId: string };
let gateway: { id: string; slug: string; secret: string };
let gatewayToken: string;


async function signInAdmin(): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email: "admin-usage@example.test",
    password: "Password123!",
    name: "Admin",
  });
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "admin-usage@example.test"));
  return cookie;
}

async function createApp(slug: string): Promise<{
  id: string;
  slug: string;
  url: string;
  planId: string;
  planName: string;
  roleId: string;
  secret: string;
}> {
  const url = `https://${slug}.example.test`;
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: {
      name: slug,
      slug,
      url,
      redirectUris: [`${url}/callback`],
      isPublic: false,
      allowedScopes: ["openid", "profile", "email"],
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    application: { id: string };
    clientId: string;
    clientSecret: string;
  };
  const plans = await db
    .select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
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
    slug: body.clientId,
    url,
    planId: plans[0].id,
    planName: plans[0].name,
    roleId: adminRole.id,
    secret: body.clientSecret,
  };
}

async function grantMachineScopes(
  applicationId: string,
  scopes: string[],
): Promise<void> {
  const res = await handle.app.inject({
    method: "PUT",
    url: `/api/admin/applications/${applicationId}/machine-scopes`,
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { scopes },
  });
  expect(res.statusCode).toBe(200);
}

async function machineToken(scope: string): Promise<string> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " +
        Buffer.from(`${gateway.slug}:${gateway.secret}`).toString("base64"),
    },
    payload: new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    }).toString(),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

async function insertSubject(id: string): Promise<void> {
  await db
    .insert(userTable)
    .values({
      id,
      name: `Subject ${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
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

async function assignAdminRole(
  userId: string,
  app: { id: string; roleId: string },
): Promise<void> {
  await db
    .insert(userApplications)
    .values({ userId, applicationId: app.id, isActive: true })
    .onConflictDoNothing();
  await db
    .insert(userAppRoles)
    .values({ userId, applicationId: app.id, roleId: app.roleId })
    .onConflictDoNothing();
}

function usageId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const usageBody = (overrides: Record<string, unknown> = {}) => ({
  subjectId: "subject-a",
  clientId: "app-b",
  resourceId: "00000000-0000-4000-8000-000000000000",
  resourceType: "model",
  resourceKey: "app-a/model-a",
  planName: appA.planName,
  requestId: usageId("event-1"),
  occurredAt: new Date().toISOString(),
  usageSource: "provider",
  costUsd: "0.010000000000000000",
  promptTokens: 6,
  completionTokens: 4,
  totalTokens: 10,
  ...overrides,
});

async function postUsage(payload: Record<string, unknown>, token = gatewayToken) {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/internal/gateway/usage",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload,
  });
  return {
    statusCode: res.statusCode,
    body: res.json() as Record<string, unknown>,
  };
}

function ownerReq(
  cookie: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return handle.app.inject({
    method,
    url,
    remoteAddress: "203.0.113.9",
    headers: {
      cookie,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

async function createPublishedResource(slug: string) {
  const resource = await createSharedResource({
    ownerApplicationId: appA.id,
    resourceType: "model",
    slug,
    displayName: slug,
  });
  const { updateSharedResource } = await import(
    "../services/resource-sharing/registry.js"
  );
  return updateSharedResource(resource.id, { status: "published" });
}

beforeAll(async () => {
  await cleanDb();
  handle = await makeAuthServer();
  adminCookie = await signInAdmin();
  appA = await createApp("app-a");
  appB = await createApp("app-b");

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
  await assignAdminRole(await userIdFor("owner-a@example.test"), appA);
  await assignAdminRole(await userIdFor("owner-b@example.test"), appB);

  const created = await createApp("gateway-usage");
  gateway = {
    id: created.id,
    slug: created.slug,
    secret: created.secret,
  };
  await grantMachineScopes(gateway.id, [
    "m2m",
    "resources:authorize",
    "resources:usage:write",
  ]);
  gatewayToken = await machineToken("resources:usage:write");
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  handle.capture.clear();
  await db.delete(usageRecords);
  await db.delete(resourceInvitations);
  await db.delete(resourceGrants);
  await db.delete(sharedResources);
});

describe("POST /api/internal/gateway/usage", () => {
  it("records idempotently and rejects a conflicting replay", async () => {
    await insertSubject("subject-a");
    const resource = await createPublishedResource("model-usage");
    await createResourceGrant({
      subjectId: "subject-a",
      ownerApplicationId: appA.id,
      resourceId: resource.id,
      planId: appA.planId,
      createdBy: "owner",
    });
    const body = usageBody({
      resourceId: resource.id,
      resourceKey: resource.key,
    });

    const first = await postUsage(body);
    expect(first.statusCode).toBe(201);
    expect(first.body.replayed).toBe(false);

    const replay = await postUsage(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.replayed).toBe(true);

    const [row] = await db.select().from(usageRecords);
    expect(row?.costUsd).toBe("0.010000000000000000");
    expect(row?.totalTokens).toBe(10);

    const conflict = await postUsage({ ...body, costUsd: "0.02" });
    expect(conflict.statusCode).toBe(409);

    const [{ value }] = await db
      .select({ value: count() })
      .from(usageRecords);
    expect(Number(value)).toBe(1);
  });

  it("rejects unknown or mismatched resources, plans and subjects", async () => {
    await insertSubject("subject-a");
    const resource = await createPublishedResource("model-invalid");
    await createResourceGrant({
      subjectId: "subject-a",
      ownerApplicationId: appA.id,
      resourceId: resource.id,
      planId: appA.planId,
      allowedClientIds: ["app-b"],
      createdBy: "owner",
    });
    const base = {
      resourceId: resource.id,
      resourceKey: resource.key,
    };

    expect((await postUsage(usageBody(base))).statusCode).toBe(201);
    for (const [field, value] of [
      ["resourceId", "00000000-0000-4000-8000-000000000001"],
      ["resourceType", "workflow"],
      ["resourceKey", "app-a/other"],
      ["planName", "ghost"],
      ["subjectId", "subject-unrelated"],
      ["clientId", "app-z"],
      ["requestId", "not-a-trusted-id"],
      ["costUsd", null],
      ["usageSource", "unsupported"],
    ] as const) {
      const result = await postUsage(
        usageBody({
          ...base,
          requestId: usageId(`invalid-${String(field)}`),
          [field]: value,
        }),
      );
      expect([400, 409]).toContain(result.statusCode);
    }
  });

  it("enforces a grant's allowed client", async () => {
    await insertSubject("subject-client");
    const resource = await createPublishedResource("model-client");
    await createResourceGrant({
      subjectId: "subject-client",
      ownerApplicationId: appA.id,
      resourceId: resource.id,
      planId: appA.planId,
      allowedClientIds: ["app-allowed"],
      createdBy: "owner",
    });
    const res = await postUsage(
      usageBody({
        subjectId: "subject-client",
        clientId: "app-denied",
        resourceId: resource.id,
        resourceKey: resource.key,
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("requires the usage machine scope", async () => {
    const authorizeOnly = await machineToken("resources:authorize");
    const res = await postUsage(usageBody(), authorizeOnly);
    expect(res.statusCode).toBe(403);
  });

  it("rejects malformed input before touching the ledger", async () => {
    const res = await postUsage(usageBody({ requestId: "short" }));
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(usageRecords)).toHaveLength(0);
  });
});

describe("owner usage API", () => {
  async function seedUsage() {
    await insertSubject("subject-a");
    await insertSubject("subject-b");
    const model = await createPublishedResource("model-a");
    const other = await createPublishedResource("model-b");
    for (const subject of ["subject-a", "subject-b"]) {
      for (const resource of [model, other]) {
        await createResourceGrant({
          subjectId: subject,
          ownerApplicationId: appA.id,
          resourceId: resource.id,
          planId: appA.planId,
          allowedClientIds: ["app-b"],
          createdBy: "owner",
        });
      }
    }
    for (const [seed, subject, resource, cost, tokens] of [
      ["a-1", "subject-a", model, "0.10", 10],
      ["a-2", "subject-b", model, "0.20", 20],
      ["b-1", "subject-a", other, "0.30", 30],
    ] as const) {
      const res = await postUsage(
        usageBody({
          subjectId: subject,
          clientId: "app-b",
          resourceId: resource.id,
          resourceKey: resource.key,
          requestId: usageId(seed),
          costUsd: cost,
          promptTokens: tokens / 2,
          completionTokens: tokens / 2,
          totalTokens: tokens,
          occurredAt: new Date().toISOString(),
        }),
      );
      expect(res.statusCode).toBe(201);
    }
    return { model, other };
  }

  it("aggregates by user and by resource with distinct totals", async () => {
    await seedUsage();
    const byUser = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/usage?groupBy=user`,
    );
    expect(byUser.statusCode).toBe(200);
    const userBody = byUser.json() as {
      items: { subjectId: string; calls: number; totalTokens: number; costUsd: string }[];
      totals: { calls: number; costUsd: string };
    };
    expect(userBody.items).toHaveLength(2);
    expect(userBody.totals.calls).toBe(3);
    expect(Number(userBody.totals.costUsd)).toBeCloseTo(0.6);
    expect(userBody.items.map((row) => row.subjectId)).toEqual([
      "subject-a",
      "subject-b",
    ]);

    const byResource = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/usage?groupBy=resource`,
    );
    expect(byResource.statusCode).toBe(200);
    const resourceBody = byResource.json() as {
      items: { resourceKey: string; calls: number }[];
    };
    expect(resourceBody.items).toHaveLength(2);
  });

  it("rejects a foreign application with a uniform 404", async () => {
    const res = await ownerReq(
      ownerBCookie,
      "GET",
      `/api/user/apps/${appA.id}/usage?groupBy=user`,
    );
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "RES_004",
    );
  });

  it("requires authentication", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: `/api/user/apps/${appA.id}/usage?groupBy=user`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("keeps usage after the resource is disabled", async () => {
    const { model } = await seedUsage();
    await db
      .update(sharedResources)
      .set({ status: "disabled" })
      .where(eq(sharedResources.id, model.id));
    const res = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/usage?groupBy=resource`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { resourceKey: string }[] };
    expect(body.items.some((row) => row.resourceKey === model.key)).toBe(true);
  });

  it("never debits the prepaid wallet", async () => {
    const before = await db.select({ value: count() }).from(walletTransactions);
    await seedUsage();
    const after = await db.select({ value: count() }).from(walletTransactions);
    expect(Number(after[0]?.value ?? 0)).toBe(Number(before[0]?.value ?? 0));
  });

  it("paginates groups deterministically", async () => {
    await seedUsage();
    const first = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/usage?groupBy=user&limit=1&offset=0`,
    );
    const body = first.json() as {
      items: { subjectId: string }[];
      hasMore: boolean;
      nextOffset: number | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(1);
  });
});

describe("M4 owner API readiness", () => {
  it("lists only the applications the session user may administer", async () => {
    const res = await ownerReq(ownerACookie, "GET", "/api/user/apps");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      apps: { id: string; permissions: string[] }[];
    };
    expect(body.apps.map((app) => app.id)).toEqual([appA.id]);
    expect(body.apps[0]?.permissions).toEqual([
      "resources:read",
      "resources:manage",
      "grants:manage",
    ]);
  });

  it("lists members and invitations and revokes an invitation", async () => {
    const members = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/members`,
    );
    expect(members.statusCode).toBe(200);
    const memberBody = members.json() as {
      members: { userId: string; roles: string[] }[];
    };
    expect(memberBody.members.some((m) => m.roles.includes("admin"))).toBe(true);

    const created = await ownerReq(
      ownerACookie,
      "POST",
      `/api/user/apps/${appA.id}/invitations`,
      {
        email: "invitee@example.test",
        planId: appA.planId,
      },
    );
    expect(created.statusCode).toBe(201);
    const invitation = (
      created.json() as { invitation: { id: string } }
    ).invitation;

    const listed = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/invitations`,
    );
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as {
      invitations: { id: string; state: string; email: string }[];
    };
    expect(listedBody.invitations).toHaveLength(1);
    expect(listedBody.invitations[0]).toMatchObject({
      id: invitation.id,
      state: "pending",
      email: "invitee@example.test",
    });

    const revoked = await ownerReq(
      ownerACookie,
      "DELETE",
      `/api/user/apps/${appA.id}/invitations/${invitation.id}`,
    );
    expect(revoked.statusCode).toBe(200);

    const again = await ownerReq(
      ownerACookie,
      "GET",
      `/api/user/apps/${appA.id}/invitations`,
    );
    expect(
      (again.json() as { invitations: { state: string }[] }).invitations[0]
        ?.state,
    ).toBe("revoked");
  });

  it("isolates member and invitation reads across owners", async () => {
    for (const path of ["members", "invitations"]) {
      const res = await ownerReq(
        ownerBCookie,
        "GET",
        `/api/user/apps/${appA.id}/${path}`,
      );
      expect(res.statusCode).toBe(404);
    }
  });
});
