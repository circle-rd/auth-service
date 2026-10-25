import { createHash, randomBytes } from "node:crypto";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.COMPAT_PROFILE = "auth0";
});

import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
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

const APP_URL = "https://auth0-app.example.com";
const REDIRECT = `${APP_URL}/callback`;

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

async function createApp(cookie: string) {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie, "content-type": "application/json" },
    payload: {
      name: "Auth0 app",
      slug: "auth0-app",
      url: APP_URL,
      redirectUris: [REDIRECT],
      isPublic: false,
      skipConsent: true,
      allowedScopes: ["openid", "profile", "email"],
    },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { clientSecret: string };
}

function token(body: Record<string, string>, authorization?: string) {
  return handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization ? { authorization } : {}),
    },
    payload: new URLSearchParams(body).toString(),
  });
}

describe("auth0 compatibility profile", () => {
  it("authenticates a confidential client with the secret in the body, not Basic", async () => {
    const cookie = await signInAdmin();
    const { clientSecret } = await createApp(cookie);

    const post = await token({
      grant_type: "client_credentials",
      client_id: "auth0-app",
      client_secret: clientSecret,
      resource: APP_URL,
    });
    expect(post.statusCode).toBe(200);

    const basic = await token(
      { grant_type: "client_credentials", resource: APP_URL },
      "Basic " + Buffer.from(`auth0-app:${clientSecret}`).toString("base64"),
    );
    expect(basic.statusCode).toBe(401);
  });

  it("accepts `audience` as an alias of `resource` and still issues opaque tokens without one", async () => {
    const cookie = await signInAdmin();
    const { clientSecret } = await createApp(cookie);

    const verifier = randomBytes(32).toString("base64url");
    const authorizeWith = async (extra: Record<string, string>) => {
      const res = await handle.app.inject({
        method: "GET",
        url:
          "/api/auth/oauth2/authorize?" +
          new URLSearchParams({
            client_id: "auth0-app",
            response_type: "code",
            redirect_uri: REDIRECT,
            scope: "openid",
            code_challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
            code_challenge_method: "S256",
            ...extra,
          }),
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
      return new URL(String(res.headers.location)).searchParams.get("code");
    };
    const exchange = async (code: string | null) => {
      const res = await token({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id: "auth0-app",
        client_secret: clientSecret,
      });
      expect(res.statusCode).toBe(200);
      return (JSON.parse(res.body) as { access_token: string }).access_token;
    };

    const withAudience = await exchange(await authorizeWith({ audience: APP_URL }));
    const [header] = withAudience.split(".");
    expect(
      JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
    ).toMatchObject({ alg: "RS256" });

    // Auth0 only issues a JWT for an API when an audience is requested.
    const without = await exchange(await authorizeWith({}));
    expect(without.split(".")).toHaveLength(1);
  });

  it("serves the tenant-domain paths, including a form token request", async () => {
    const cookie = await signInAdmin();
    const { clientSecret } = await createApp(cookie);

    const jwks = await handle.app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    expect(jwks.statusCode).toBe(200);

    // auth0-spa-js posts a form (`useFormData`, its default); JSON bodies are
    // not accepted by the token endpoint.
    const json = await handle.app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "auth0-app",
        client_secret: clientSecret,
        audience: APP_URL,
      }).toString(),
    });
    expect(json.statusCode).toBe(200);
    const { access_token } = JSON.parse(json.body) as { access_token: string };
    expect(access_token.split(".")).toHaveLength(3);
  });
});
