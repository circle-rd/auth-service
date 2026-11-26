import { createHash, randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  oauthAccessToken,
  oauthClient,
  oauthResource,
  member,
  organization,
  user as userTable,
} from "../db/auth-schema.js";
import {
  gatewayObjects,
  resourceGatewayLinks,
} from "../db/gateway-schema.js";
import { personalGatewayKeys } from "../db/gateway-key-schema.js";
import {
  resourceGrants,
  resourceUsageRecords,
  resources,
} from "../db/resource-schema.js";
import { hashOpaqueToken } from "../services/oauth-tokens.js";
import { signDecision } from "../services/resources/decision-token.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";

const APP_SLUG = "gateway-consumer";
const REDIRECT = "https://consumer.example.com/callback";
const MACHINE_TOKEN = "machine-token-gateway";
const MACHINE_CLIENT = "litellm-machine";

let handle: AuthServerHandle;
let userId: string;
let appId: string;
let sessionCookie: string;
let bearer: string;
let ownedResourceId: string;

async function createConsumerApplication(): Promise<void> {
  const created = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    payload: {
      name: "Gateway consumer",
      slug: APP_SLUG,
      url: "https://consumer.example.com",
      redirectUris: [REDIRECT],
      resourceSharingEnabled: true,
      skipConsent: true,
      allowedResources: [config.betterAuth.url],
      allowedScopes: ["openid", "profile", "email"],
    },
  });
  if (created.statusCode !== 201) {
    throw new Error(`application create failed: ${created.body}`);
  }
  const body = created.json() as {
    application: { id: string };
    clientSecret: string;
  };
  appId = body.application.id;
  await enableSchemeForApplication(appId, "llm");

  const verifier = randomBytes(32).toString("base64url");
  const authorize = await handle.app.inject({
    method: "GET",
    url:
      "/api/auth/oauth2/authorize?" +
      new URLSearchParams({
        client_id: APP_SLUG,
        response_type: "code",
        redirect_uri: REDIRECT,
        scope: "openid resources:self:manage",
        resource: config.betterAuth.url,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }),
    headers: { cookie: sessionCookie },
  });
  expect(authorize.statusCode).toBe(302);
  const code = new URL(
    String(authorize.headers.location),
    config.betterAuth.url,
  ).searchParams.get(
    "code",
  );
  if (!code) {
    throw new Error(`authorize redirect: ${String(authorize.headers.location)}`);
  }
  const token = await handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " +
        Buffer.from(`${APP_SLUG}:${body.clientSecret}`).toString("base64"),
    },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }).toString(),
  });
  if (token.statusCode !== 200) throw new Error(token.body);
  bearer = (token.json() as { access_token: string }).access_token;
}

async function seedResource(
  name: string,
  owner: "user" | "application",
): Promise<string> {
  const [resource] = await db
    .insert(resources)
    .values({
      applicationId: appId,
      scheme: "llm",
      locator: `${APP_SLUG}/${name}`,
      uri: `llm://${APP_SLUG}/${name}`,
      displayName: name,
      ownerType: owner,
      ownerId: owner === "user" ? userId : appId,
      status: "validated",
    })
    .returning();
  if (!resource) throw new Error("resource seed failed");
  const [object] = await db
    .insert(gatewayObjects)
    .values({
      kind: "model",
      litellmId: `litellm-${name}`,
      objectName: name,
      displayName: name,
    })
    .returning();
  if (!object) throw new Error("gateway object seed failed");
  await db.insert(resourceGatewayLinks).values({
    resourceId: resource.id,
    gatewayObjectId: object.id,
  });
  return resource.id;
}

async function seedMachineClient(): Promise<void> {
  await db.insert(oauthClient).values({
    id: "oc-gateway-machine",
    clientId: MACHINE_CLIENT,
    redirectUris: [],
    scopes: ["openid"],
    clientCredentialsScopes: [
      "gateway:entitlements:read",
      "resources:usage:write",
    ],
  });
  await db.insert(oauthAccessToken).values({
    id: "at-gateway-machine",
    token: hashOpaqueToken(MACHINE_TOKEN),
    clientId: MACHINE_CLIENT,
    scopes: ["gateway:entitlements:read", "resources:usage:write"],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

function asUser(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  return handle.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

function resolveKey(key: string) {
  return handle.app.inject({
    method: "POST",
    url: "/api/internal/gateway/personal-keys/entitlements",
    headers: {
      authorization: `Bearer ${MACHINE_TOKEN}`,
      "content-type": "application/json",
    },
    payload: { key },
  });
}

async function createKey(organizationId?: string) {
  const res = await asUser("POST", "/api/user/gateway-keys", {
    label: "IDE",
    ...(organizationId ? { organizationId } : {}),
  });
  if (res.statusCode !== 201) {
    throw new Error(`create key failed: ${res.statusCode} ${res.body}`);
  }
  return res.json() as {
    id: string;
    key: string;
    maskedKey: string;
    organizationId: string | null;
  };
}

beforeAll(async () => {
  await cleanDb();
  handle = await makeAuthServer();
  await syncBuiltinSchemes();
  const signed = await signUpAndSignIn(handle, {
    email: "gateway@example.com",
    password: "Password123!",
    name: "Gateway",
  });
  sessionCookie = signed.cookie;
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, "gateway@example.com"));
  if (!row) throw new Error("user seed failed");
  userId = row.id;
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.id, userId));
  await db.insert(oauthResource).values({
    id: "res-issuer",
    identifier: config.betterAuth.url,
    name: "auth-service",
  });
  await createConsumerApplication();
  await seedMachineClient();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    personal_gateway_keys,
    resource_usage_records,
    resource_grants,
    resource_invitations,
    resource_gateway_links,
    gateway_objects,
    resources,
    member,
    organization
    RESTART IDENTITY CASCADE`);
  ownedResourceId = await seedResource("model-owned", "user");
});

describe("personal gateway key lifecycle", () => {
  it("creates once, lists masked, resolves, and dies on revoke", async () => {
    const created = await createKey();
    expect(created.key).toMatch(/^cgk_[A-Za-z0-9_-]{43}$/);
    expect(created.maskedKey).not.toBe(created.key);

    const listed = await asUser("GET", "/api/user/gateway-keys");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().keys).toEqual([
      expect.objectContaining({
        id: created.id,
        maskedKey: created.maskedKey,
        organizationId: null,
      }),
    ]);
    expect(listed.body).not.toContain(created.key);

    const resolved = await resolveKey(created.key);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      keyId: created.id,
      subjectId: userId,
      clientId: APP_SLUG,
      models: ["model-owned"],
    });
    const [used] = await db
      .select({ lastUsedAt: personalGatewayKeys.lastUsedAt })
      .from(personalGatewayKeys)
      .where(eq(personalGatewayKeys.id, created.id));
    expect(used?.lastUsedAt).not.toBeNull();

    expect(
      (await asUser("DELETE", `/api/user/gateway-keys/${created.id}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await asUser("DELETE", `/api/user/gateway-keys/${created.id}`))
        .statusCode,
    ).toBe(204);
    const dead = await resolveKey(created.key);
    expect(dead.statusCode).toBe(401);
    expect(dead.json().error.code).toBe("KEY_001");
  });

  it("refuses creation from a web session and a foreign revoke", async () => {
    const fromSession = await handle.app.inject({
      method: "POST",
      url: "/api/user/gateway-keys",
      headers: { cookie: sessionCookie },
      payload: { label: "IDE" },
    });
    expect(fromSession.statusCode).toBe(403);
    expect(fromSession.json().error.code).toBe("KEY_004");

    await db.insert(userTable).values({
      id: "other-user",
      name: "Other",
      email: "other@example.com",
      emailVerified: true,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [foreignKey] = await db
      .insert(personalGatewayKeys)
      .values({
        userId: "other-user",
        applicationId: appId,
        label: "Other IDE",
        keyHash: "x".repeat(43),
        maskedKey: "cgk_xxxxxx…xxxx",
      })
      .returning({ id: personalGatewayKeys.id });
    const foreign = await asUser(
      "DELETE",
      `/api/user/gateway-keys/${foreignKey!.id}`,
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("KEY_002");
  });
});

describe("pool semantics", () => {
  async function seedPool() {
    const organizationId = "org-gateway";
    await db.insert(organization).values({
      id: organizationId,
      name: "Gateway pool",
      slug: "gateway-pool",
      createdAt: new Date(),
    });
    await db.insert(member).values({
      id: "member-gateway",
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    return organizationId;
  }

  it("narrows a pool key to owned and organization resources only", async () => {
    const organizationId = await seedPool();
    const orgResourceId = await seedResource("model-org", "application");
    const userResource = await seedResource("model-user", "application");
    await db.insert(resourceGrants).values([
      {
        resourceId: orgResourceId,
        subjectType: "organization",
        subjectId: organizationId,
        permission: "read",
        createdBy: userId,
      },
      {
        resourceId: userResource,
        subjectType: "user",
        subjectId: userId,
        permission: "read",
        createdBy: userId,
      },
    ]);

    const network = await createKey();
    const networkAnswer = await resolveKey(network.key);
    expect(networkAnswer.json().models.sort()).toEqual([
      "model-org",
      "model-owned",
      "model-user",
    ]);

    const pool = await createKey(organizationId);
    const poolAnswer = await resolveKey(pool.key);
    expect(poolAnswer.json().models.sort()).toEqual([
      "model-org",
      "model-owned",
    ]);
  });

  it("refuses a pool key once the user leaves the organization", async () => {
    const organizationId = await seedPool();
    const pool = await createKey(organizationId);
    expect((await resolveKey(pool.key)).statusCode).toBe(200);

    await db.delete(member).where(eq(member.organizationId, organizationId));
    const after = await resolveKey(pool.key);
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe("KEY_004");
  });
});

describe("usage attribution", () => {
  async function recordUsage(decisionId: string, requestId: string) {
    return handle.app.inject({
      method: "POST",
      url: "/api/internal/gateway/usage",
      headers: {
        authorization: `Bearer ${MACHINE_TOKEN}`,
        "content-type": "application/json",
      },
      payload: {
        decisionId,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        resourceId: ownedResourceId,
        resourceUri: `llm://${APP_SLUG}/model-owned`,
        requestId,
        occurredAt: new Date().toISOString(),
        usageSource: "provider",
        costUsd: "0.01",
      },
    });
  }

  it("copies the key id from the decision, and leaves it null without one", async () => {
    const created = await createKey();
    const withKey = await resolveKey(created.key);
    const keyDecision = withKey.json().decisionId as string;
    expect(
      (
        await recordUsage(keyDecision, "a".repeat(64))
      ).statusCode,
    ).toBe(201);

    const withoutKey = signDecision({
      sub: userId,
      app: APP_SLUG,
      by: MACHINE_CLIENT,
      notAfter: null,
    });
    expect(
      (
        await recordUsage(withoutKey.decisionId, "b".repeat(64))
      ).statusCode,
    ).toBe(201);

    const rows = await db
      .select({
        requestId: resourceUsageRecords.requestId,
        gatewayKeyId: resourceUsageRecords.gatewayKeyId,
      })
      .from(resourceUsageRecords);
    expect(rows).toEqual(
      expect.arrayContaining([
        { requestId: "a".repeat(64), gatewayKeyId: created.id },
        { requestId: "b".repeat(64), gatewayKeyId: null },
      ]),
    );
  });
});
