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
  resource: string,
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
      resource,
    }).toString(),
  });
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as Record<string, unknown>,
  };
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
