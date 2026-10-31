import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { userApplications } from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

let handle: AuthServerHandle;

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  handle.capture.clear();
});

/** Sign in a superadmin and return the session cookie header value. */
async function signInAdmin(): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email: "admin@example.com",
    password: "Password123!",
    name: "Admin",
  });
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "admin@example.com"));
  return cookie;
}

/** Create a confidential application and return its id/slug/one-time secret. */
async function createConfidentialApp(
  cookie: string,
  opts: { slug: string; url: string },
): Promise<{ id: string; slug: string; secret: string; url: string }> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie, "content-type": "application/json" },
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
  const body = JSON.parse(res.body) as {
    application: { id: string };
    clientId: string;
    clientSecret: string;
  };
  return {
    id: body.application.id,
    slug: body.clientId,
    secret: body.clientSecret,
    url: opts.url,
  };
}

async function requestClientCredentialsToken(
  slug: string,
  secret: string,
  resource?: string,
  scope?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " + Buffer.from(`${slug}:${secret}`).toString("base64"),
    },
    payload: new URLSearchParams({
      grant_type: "client_credentials",
      ...(resource ? { resource } : {}),
      ...(scope ? { scope } : {}),
    }).toString(),
  });
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as Record<string, unknown>,
  };
}

async function grantMachineScopes(
  cookie: string,
  applicationId: string,
  scopes: string[],
): Promise<void> {
  const res = await handle.app.inject({
    method: "PUT",
    url: `/api/admin/applications/${applicationId}/machine-scopes`,
    headers: { cookie, "content-type": "application/json" },
    payload: { scopes },
  });
  expect(res.statusCode).toBe(200);
}

async function insertUserWithAccess(
  id: string,
  applicationIds: string[],
): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: "User",
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db
    .insert(userApplications)
    .values(
      applicationIds.map((applicationId) => ({
        userId: id,
        applicationId,
        isActive: true,
      })),
    );
}

describe("client_credentials → /api/consumption end to end", () => {
  it("accepts a machine token bound to the calling application", async () => {
    const cookie = await signInAdmin();
    const app1 = await createConfidentialApp(cookie, {
      slug: "m2m-app",
      url: "https://m2m-app.example.com",
    });

    // Target user with access to the app.
    await db.insert(userTable).values({
      id: "u-1",
      name: "User",
      email: "u1@example.com",
      emailVerified: true,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(userApplications).values({
      userId: "u-1",
      applicationId: app1.id,
      isActive: true,
    });

    const token = await requestClientCredentialsToken(
      app1.slug,
      app1.secret,
      app1.url,
    );
    expect(token.statusCode).toBe(200);
    const accessToken = token.body.access_token as string;
    // A resource was requested → the token is a signed JWT.
    expect(accessToken.split(".").length).toBe(3);

    const report = await handle.app.inject({
      method: "POST",
      url: "/api/consumption",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      payload: {
        applicationId: app1.id,
        userId: "u-1",
        key: "api.calls",
        value: 1,
      },
    });
    expect(report.statusCode).toBe(200);
    const body = JSON.parse(report.body) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("rejects a machine token used for another application", async () => {
    const cookie = await signInAdmin();
    const app1 = await createConfidentialApp(cookie, {
      slug: "m2m-app",
      url: "https://m2m-app.example.com",
    });
    const app2 = await createConfidentialApp(cookie, {
      slug: "other-app",
      url: "https://other-app.example.com",
    });

    await db.insert(userTable).values({
      id: "u-1",
      name: "User",
      email: "u1@example.com",
      emailVerified: true,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(userApplications).values([
      { userId: "u-1", applicationId: app1.id, isActive: true },
      { userId: "u-1", applicationId: app2.id, isActive: true },
    ]);

    const token = await requestClientCredentialsToken(
      app1.slug,
      app1.secret,
      app1.url,
    );
    expect(token.statusCode).toBe(200);

    const report = await handle.app.inject({
      method: "POST",
      url: "/api/consumption",
      headers: {
        authorization: `Bearer ${token.body.access_token as string}`,
        "content-type": "application/json",
      },
      payload: {
        applicationId: app2.id,
        userId: "u-1",
        key: "api.calls",
        value: 1,
      },
    });
    // Valid token, but not authorized for this application.
    expect(report.statusCode).toBe(403);
  });
});

describe("client_credentials → /api/app/consumption end to end", () => {
  const SCOPES = ["m2m", "consumption:write", "consumption:read"];

  it("reports and reads usage of the calling application with an opaque token", async () => {
    const cookie = await signInAdmin();
    const app1 = await createConfidentialApp(cookie, {
      slug: "m2m-app",
      url: "https://m2m-app.example.com",
    });
    await grantMachineScopes(cookie, app1.id, SCOPES);
    await insertUserWithAccess("u-1", [app1.id]);

    // No resource: the token is opaque, as the SDK requests it.
    const token = await requestClientCredentialsToken(
      app1.slug,
      app1.secret,
      undefined,
      "consumption:write consumption:read",
    );
    expect(token.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${token.body.access_token as string}`,
      "content-type": "application/json",
    };

    for (const value of [2, 3]) {
      const report = await handle.app.inject({
        method: "POST",
        url: "/api/app/consumption/users/u-1",
        headers,
        payload: { key: "api.calls", value },
      });
      expect(report.statusCode).toBe(200);
    }

    const list = await handle.app.inject({
      method: "GET",
      url: "/api/app/consumption/users/u-1",
      headers,
    });
    const { aggregates } = JSON.parse(list.body) as {
      aggregates: { key: string; total: string }[];
    };
    expect(aggregates.map((a) => [a.key, Number(a.total)])).toEqual([
      ["api.calls", 5],
    ]);

    const one = await handle.app.inject({
      method: "GET",
      url: "/api/app/consumption/users/u-1/api.calls",
      headers,
    });
    expect(one.statusCode).toBe(200);
    expect(Number(JSON.parse(one.body).aggregate.total)).toBe(5);

    const missing = await handle.app.inject({
      method: "GET",
      url: "/api/app/consumption/users/u-1/ghost",
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("never exposes the usage of another application", async () => {
    const cookie = await signInAdmin();
    const app1 = await createConfidentialApp(cookie, {
      slug: "m2m-app",
      url: "https://m2m-app.example.com",
    });
    const app2 = await createConfidentialApp(cookie, {
      slug: "other-app",
      url: "https://other-app.example.com",
    });
    await grantMachineScopes(cookie, app1.id, SCOPES);
    await grantMachineScopes(cookie, app2.id, SCOPES);
    await insertUserWithAccess("u-1", [app1.id, app2.id]);

    const scope = "consumption:write consumption:read";
    const token1 = await requestClientCredentialsToken(
      app1.slug,
      app1.secret,
      undefined,
      scope,
    );
    const token2 = await requestClientCredentialsToken(
      app2.slug,
      app2.secret,
      undefined,
      scope,
    );
    await handle.app.inject({
      method: "POST",
      url: "/api/app/consumption/users/u-1",
      headers: {
        authorization: `Bearer ${token1.body.access_token as string}`,
        "content-type": "application/json",
      },
      payload: { key: "api.calls", value: 7 },
    });

    const other = await handle.app.inject({
      method: "GET",
      url: "/api/app/consumption/users/u-1",
      headers: {
        authorization: `Bearer ${token2.body.access_token as string}`,
      },
    });
    expect(JSON.parse(other.body)).toEqual({ aggregates: [] });
  });

  it("requires the dedicated scope: a plain m2m token is refused", async () => {
    const cookie = await signInAdmin();
    const app1 = await createConfidentialApp(cookie, {
      slug: "m2m-app",
      url: "https://m2m-app.example.com",
    });
    await insertUserWithAccess("u-1", [app1.id]);

    const token = await requestClientCredentialsToken(
      app1.slug,
      app1.secret,
    );
    expect(token.statusCode).toBe(200);
    const report = await handle.app.inject({
      method: "POST",
      url: "/api/app/consumption/users/u-1",
      headers: {
        authorization: `Bearer ${token.body.access_token as string}`,
        "content-type": "application/json",
      },
      payload: { key: "api.calls", value: 1 },
    });
    expect(report.statusCode).toBe(403);
  });
});
