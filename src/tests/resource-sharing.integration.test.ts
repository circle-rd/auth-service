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
import { resourceGrants, sharedResources, userApplications } from "../db/schema.js";
import { createSharedResource } from "../services/resource-sharing/registry.js";
import type { SharedResource } from "../services/resource-sharing/types.js";
import { createResourceGrant } from "../services/resource-sharing/grants.js";
import { authorize } from "../services/resource-sharing/policy.js";

let handle: AuthServerHandle;
let adminCookie: string;
let ownerApp: { id: string; slug: string; url: string; planId: string };
let gateway: { id: string; slug: string; secret: string };

const AUDIENCE = "https://gateway.example.test";

async function signInAdmin(): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email: "admin@example.test",
    password: "Password123!",
    name: "Admin",
  });
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "admin@example.test"));
  return cookie;
}

async function createConfidentialApp(opts: {
  slug: string;
  url: string;
}): Promise<{ id: string; slug: string; secret: string }> {
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
  const body = res.json() as {
    application: { id: string };
    clientId: string;
    clientSecret: string;
  };
  return {
    id: body.application.id,
    slug: body.clientId,
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

async function machineToken(): Promise<string> {
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
      scope: "resources:authorize",
    }).toString(),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { access_token: string };
  return body.access_token;
}

async function insertSubject(id: string): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: "Subject",
    email: `${id}@example.test`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function createPublishedResource(
  slug: string,
  type: "model" | "workflow" = "model",
): Promise<SharedResource> {
  const resource = await createSharedResource({
    ownerApplicationId: ownerApp.id,
    resourceType: type,
    slug,
    displayName: slug,
  });
  return dbUpdateStatus(resource);
}

async function dbUpdateStatus(
  resource: SharedResource,
): Promise<SharedResource> {
  const { updateSharedResource } = await import(
    "../services/resource-sharing/registry.js"
  );
  return updateSharedResource(resource.id, { status: "published" });
}

async function postAuthorize(
  body: Record<string, unknown>,
  token = gatewayToken,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/internal/gateway/authorize",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: body,
  });
  return {
    statusCode: res.statusCode,
    body: res.json() as Record<string, unknown>,
  };
}

const authorizeBody = (overrides: Record<string, unknown> = {}) => ({
  subjectId: "subject-a",
  clientId: "app-b",
  resourceType: "model",
  key: "app-a/model-a",
  audience: AUDIENCE,
  requestId: "req-1",
  ...overrides,
});

let gatewayToken: string;

beforeAll(async () => {
  await cleanDb();
  handle = await makeAuthServer();
  adminCookie = await signInAdmin();
  ownerApp = {
    ...(await createConfidentialApp({
      slug: "app-a",
      url: "https://app-a.example.test",
    })),
    url: "https://app-a.example.test",
    planId: "",
  };
  const plans = await handle.app.inject({
    method: "GET",
    url: `/api/admin/applications/${ownerApp.id}/plans`,
    headers: { cookie: adminCookie },
  });
  const body = plans.json() as { plans: { id: string; isDefault: boolean }[] };
  const free = body.plans.find((p) => p.isDefault);
  if (!free) throw new Error("default plan missing");
  ownerApp.planId = free.id;

  gateway = await createConfidentialApp({
    slug: "gateway",
    url: "https://gateway.example.test",
  });
  await grantMachineScopes(gateway.id, ["m2m", "resources:authorize"]);
  gatewayToken = await machineToken();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  handle.capture.clear();
  await db.delete(resourceGrants);
  await db.delete(sharedResources);
});

describe("POST /api/internal/gateway/authorize", () => {
  it("denies a valid token without a grant and echoes no metadata (AC-02)", async () => {
    await insertSubject("subject-deny");
    await createPublishedResource("model-deny");

    const response = await postAuthorize(
      authorizeBody({ subjectId: "subject-deny", key: "app-a/model-deny" }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ decision: "deny" });
  });

  it("denies an unknown resource uniformly", async () => {
    await insertSubject("subject-unknown");
    const response = await postAuthorize(
      authorizeBody({ subjectId: "subject-unknown", key: "app-a/unknown" }),
    );
    expect(response.body).toEqual({ decision: "deny" });
  });

  it("requires the resources:authorize machine scope", async () => {
    await insertSubject("subject-scope");
    const response = await postAuthorize(
      authorizeBody({ subjectId: "subject-scope" }),
      "invalid-token",
    );
    expect(response.statusCode).toBe(401);
  });

  it("rejects malformed input with a 400", async () => {
    const response = await postAuthorize(
      authorizeBody({ resourceType: "ssh_host" }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("allows an explicit grant and attributes owner, plan and resource (AC-07)", async () => {
    await insertSubject("subject-allow");
    const resource = await createPublishedResource("model-allow");
    await createResourceGrant({
      subjectId: "subject-allow",
      ownerApplicationId: ownerApp.id,
      resourceId: resource.id,
      planId: ownerApp.planId,
      createdBy: "owner",
    });

    const response = await postAuthorize(
      authorizeBody({
        subjectId: "subject-allow",
        key: "app-a/model-allow",
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      decision: "allow",
      ownerApplicationSlug: "app-a",
      planName: "free",
      teamId: "app-a:free",
      resourceId: resource.id,
    });

    const decision = await authorize({
      subjectId: "subject-allow",
      clientId: "app-b",
      resourceType: "model",
      key: "app-a/model-allow",
      audience: AUDIENCE,
    });
    expect(decision).toMatchObject({
      decision: "allow",
      subjectId: "subject-allow",
      clientId: "app-b",
      ownerApplicationSlug: "app-a",
      resourceId: resource.id,
    });
  });

  it("allows an existing owner-application member without an explicit grant", async () => {
    await insertSubject("subject-membership");
    await createPublishedResource("model-membership");
    await db.insert(userApplications).values({
      userId: "subject-membership",
      applicationId: ownerApp.id,
      isActive: true,
    });

    const response = await postAuthorize(
      authorizeBody({
        subjectId: "subject-membership",
        key: "app-a/model-membership",
      }),
    );
    expect(response.body).toEqual({
      decision: "allow",
      ownerApplicationSlug: "app-a",
      planName: "free",
      teamId: "app-a:free",
      resourceId: expect.any(String),
    });
  });

  it("enforces allowed_client_ids", async () => {
    await insertSubject("subject-clients");
    const resource = await createPublishedResource("model-clients");
    await createResourceGrant({
      subjectId: "subject-clients",
      ownerApplicationId: ownerApp.id,
      resourceId: resource.id,
      planId: ownerApp.planId,
      allowedClientIds: ["app-b"],
      createdBy: "owner",
    });

    expect(
      (
        await postAuthorize(
          authorizeBody({
            subjectId: "subject-clients",
            key: "app-a/model-clients",
          }),
        )
      ).body.decision,
    ).toBe("allow");
    expect(
      (
        await postAuthorize(
          authorizeBody({
            subjectId: "subject-clients",
            clientId: "app-c",
            key: "app-a/model-clients",
          }),
        )
      ).body,
    ).toEqual({ decision: "deny" });
  });

  it("denies a revoked grant", async () => {
    await insertSubject("subject-revoked");
    const resource = await createPublishedResource("model-revoked");
    const grant = await createResourceGrant({
      subjectId: "subject-revoked",
      ownerApplicationId: ownerApp.id,
      resourceId: resource.id,
      planId: ownerApp.planId,
      createdBy: "owner",
    });
    const { revokeResourceGrant } = await import(
      "../services/resource-sharing/grants.js"
    );
    await revokeResourceGrant(grant.id);

    expect(
      (
        await postAuthorize(
          authorizeBody({
            subjectId: "subject-revoked",
            key: "app-a/model-revoked",
          }),
        )
      ).body,
    ).toEqual({ decision: "deny" });
  });

  it("denies an expired grant", async () => {
    await insertSubject("subject-expired");
    const resource = await createPublishedResource("model-expired");
    await createResourceGrant({
      subjectId: "subject-expired",
      ownerApplicationId: ownerApp.id,
      resourceId: resource.id,
      planId: ownerApp.planId,
      expiresAt: new Date(Date.now() - 60_000),
      createdBy: "owner",
    });

    expect(
      (
        await postAuthorize(
          authorizeBody({
            subjectId: "subject-expired",
            key: "app-a/model-expired",
          }),
        )
      ).body,
    ).toEqual({ decision: "deny" });
  });

  it("denies a draft or disabled resource", async () => {
    await insertSubject("subject-draft");
    const draft = await createSharedResource({
      ownerApplicationId: ownerApp.id,
      resourceType: "model",
      slug: "model-draft",
      displayName: "model-draft",
    });
    await createResourceGrant({
      subjectId: "subject-draft",
      ownerApplicationId: ownerApp.id,
      resourceId: draft.id,
      planId: ownerApp.planId,
      createdBy: "owner",
    });
    expect(
      (
        await postAuthorize(
          authorizeBody({
            subjectId: "subject-draft",
            key: "app-a/model-draft",
          }),
        )
      ).body,
    ).toEqual({ decision: "deny" });

    const { updateSharedResource } = await import(
      "../services/resource-sharing/registry.js"
    );
    await updateSharedResource(draft.id, { status: "disabled" });
    expect(
      (
        await postAuthorize(
          authorizeBody({
            subjectId: "subject-draft",
            key: "app-a/model-draft",
          }),
        )
      ).body,
    ).toEqual({ decision: "deny" });
  });
});

describe("GET /api/internal/gateway/resources/accessible", () => {
  it("lists only resources the subject may reach", async () => {
    await insertSubject("subject-list");
    await insertSubject("subject-none");
    const model = await createPublishedResource("model-accessible");
    await createPublishedResource("flow-accessible", "workflow");
    await createResourceGrant({
      subjectId: "subject-list",
      ownerApplicationId: ownerApp.id,
      resourceId: model.id,
      planId: ownerApp.planId,
      createdBy: "owner",
    });

    const res = await handle.app.inject({
      method: "GET",
      url:
        "/api/internal/gateway/resources/accessible" +
        "?subjectId=subject-list&clientId=app-b&resourceType=model&audience=" +
        encodeURIComponent(AUDIENCE),
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resources: { resourceId: string; resourceUri: string }[];
    };
    expect(body.resources).toEqual([
      expect.objectContaining({
        resourceId: model.id,
        resourceUri: "llm://app-a/model-accessible",
      }),
    ]);

    const other = await handle.app.inject({
      method: "GET",
      url:
        "/api/internal/gateway/resources/accessible" +
        "?subjectId=subject-none&clientId=app-b&resourceType=model&audience=" +
        encodeURIComponent(AUDIENCE),
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    expect((other.json() as { resources: unknown[] }).resources).toEqual([]);
  });

  it("requires the resources:authorize machine scope", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/api/internal/gateway/resources/accessible?subjectId=s&clientId=c&resourceType=model&audience=a",
    });
    expect(res.statusCode).toBe(401);
  });
});
