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
  process.env.COMPAT_PROFILE = "okta";
});

import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { jwks, oauthClient, user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { ensureSigningKey } from "../compat/signing-keys.js";
import { reconcileTokenAuthMethod } from "../compat/token-auth.js";

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

const APP_URL = "https://okta-app.example.com";
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
      name: "Okta app",
      slug: "okta-app",
      url: APP_URL,
      redirectUris: [REDIRECT],
      isPublic: false,
      skipConsent: true,
      allowedScopes: ["openid", "profile", "email", "groups"],
    },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { clientSecret: string };
}

const basic = (id: string, secret: string) =>
  "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

function decode(jwt: string) {
  const [h, p] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(p ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >,
  };
}

describe("okta compatibility profile", () => {
  it("issues an RS256 JWT without a resource and with Okta-style claims", async () => {
    const cookie = await signInAdmin();
    const { clientSecret } = await createApp(cookie);

    const verifier = randomBytes(32).toString("base64url");
    const authorize = await handle.app.inject({
      method: "GET",
      url:
        "/api/auth/oauth2/authorize?" +
        new URLSearchParams({
          client_id: "okta-app",
          response_type: "code",
          redirect_uri: REDIRECT,
          scope: "openid profile groups",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        }),
      headers: { cookie },
    });
    expect(authorize.statusCode).toBe(302);
    const code = new URL(String(authorize.headers.location)).searchParams.get(
      "code",
    );
    expect(code).toBeTruthy();

    const token = await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic("okta-app", clientSecret),
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const tokens = JSON.parse(token.body) as {
      access_token: string;
      id_token: string;
    };

    const access = decode(tokens.access_token);
    expect(access.header.alg).toBe("RS256");
    expect(access.payload.aud).toEqual(expect.arrayContaining([APP_URL]));
    expect(access.payload.groups).toEqual(["admin"]);
    expect(access.payload.scp).toEqual(["openid", "profile", "groups"]);
    expect(access.payload.cid).toBe("okta-app");
    expect(access.payload.preferred_username).toBe("admin@example.com");
    // Claims that were only computed to feed a mapping are not disclosed.
    expect(access.payload).not.toHaveProperty("roles");
    expect(access.payload).not.toHaveProperty("email");

    expect(decode(tokens.id_token).header.alg).toBe("RS256");
  });

  it("issues a JWT to a client_credentials request without a resource", async () => {
    const cookie = await signInAdmin();
    const { clientSecret } = await createApp(cookie);

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic("okta-app", clientSecret),
      },
      payload: "grant_type=client_credentials",
    });
    expect(res.statusCode).toBe(200);
    const { access_token } = JSON.parse(res.body) as { access_token: string };
    const jwt = decode(access_token);
    expect(jwt.header.alg).toBe("RS256");
    expect(jwt.payload.aud).toBe(APP_URL);
  });

  it("advertises RS256 and publishes an RSA key", async () => {
    const cookie = await signInAdmin();
    await createApp(cookie);

    const discovery = await handle.app.inject({
      method: "GET",
      url: "/.well-known/openid-configuration",
    });
    const meta = JSON.parse(discovery.body) as {
      id_token_signing_alg_values_supported: string[];
      scopes_supported: string[];
    };
    expect(meta.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(meta.scopes_supported).toContain("groups");

    // The first token request creates the signing key.
    await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "grant_type=client_credentials",
    });
    const keys = await handle.app.inject({
      method: "GET",
      url: "/api/auth/jwks",
    });
    const set = JSON.parse(keys.body) as { keys: { kty?: string }[] };
    expect(set.keys.every((k) => k.kty === "RSA")).toBe(true);
  });

  it("creates a key of the configured algorithm next to an existing one", async () => {
    const now = new Date();
    await db.insert(jwks).values({
      id: "legacy-eddsa",
      publicKey: "{}",
      privateKey: "{}",
      createdAt: now,
      alg: "EdDSA",
      crv: "Ed25519",
    });

    await ensureSigningKey();
    const rows = await db.select({ alg: jwks.alg }).from(jwks);
    expect(rows.map((r) => r.alg).sort()).toEqual(["EdDSA", "RS256"]);

    // Idempotent once a key of the configured algorithm exists.
    await ensureSigningKey();
    expect(await db.select().from(jwks)).toHaveLength(2);
  });

  it("moves confidential clients to the configured authentication method", async () => {
    const cookie = await signInAdmin();
    await createApp(cookie);
    await db
      .update(oauthClient)
      .set({ tokenEndpointAuthMethod: "client_secret_post" })
      .where(eq(oauthClient.clientId, "okta-app"));

    await reconcileTokenAuthMethod();
    const [row] = await db
      .select({ method: oauthClient.tokenEndpointAuthMethod })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "okta-app"));
    expect(row?.method).toBe("client_secret_basic");
  });

  it("answers the Okta endpoint paths through the same guards", async () => {
    const cookie = await signInAdmin();
    const { clientSecret } = await createApp(cookie);

    const token = await handle.app.inject({
      method: "POST",
      url: "/oauth2/default/v1/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic("okta-app", clientSecret),
      },
      payload: "grant_type=client_credentials",
    });
    expect(token.statusCode).toBe(200);

    const keys = await handle.app.inject({
      method: "GET",
      url: "/oauth2/default/v1/keys",
    });
    expect(keys.statusCode).toBe(200);
    expect(JSON.parse(keys.body).keys.length).toBeGreaterThan(0);

    const authorize = await handle.app.inject({
      method: "GET",
      url: "/oauth2/default/v1/authorize?client_id=okta-app&response_type=code",
    });
    // Same behaviour as the canonical endpoint: an error redirect, not a 404.
    expect(authorize.statusCode).not.toBe(404);

    // An alias of another provider is not served.
    const auth0 = await handle.app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: "grant_type=client_credentials",
    });
    expect(auth0.statusCode).toBe(404);
  });
});
