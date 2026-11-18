import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

const RELAY_URL = "https://relay.example.com";
const CLIENT_ID = "reverse-agent";

vi.hoisted(() => {
  process.env.OAUTH_DEVICE_GRANT_ENABLED = "true";
  process.env.REVERSE_AGENT_CLIENT_ID = "reverse-agent";
  process.env.REVERSE_AGENT_RESOURCE = "https://relay.example.com/ignored/path";
  process.env.JWT_PRIMARY_ALG = "EdDSA";
  // Several accounts are created per test; the default credential bucket is
  // sized for humans, not a suite.
  process.env.RATE_LIMIT_AUTH_MAX = "100";
});

import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import {
  oauthClient,
  oauthClientResource,
  oauthResource,
  user as userTable,
} from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { bootstrap } from "../bootstrap.js";
import { revokeUserRefreshTokens } from "../services/oauth-tokens.js";

let handle: AuthServerHandle;

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
  delete process.env.OAUTH_DEVICE_GRANT_ENABLED;
  delete process.env.REVERSE_AGENT_CLIENT_ID;
  delete process.env.REVERSE_AGENT_RESOURCE;
  delete process.env.JWT_PRIMARY_ALG;
  delete process.env.RATE_LIMIT_AUTH_MAX;
});

beforeEach(async () => {
  await cleanDb();
  await bootstrap();
  handle.capture.clear();
});

function form(values: Record<string, string>): {
  headers: Record<string, string>;
  payload: string;
} {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(values).toString(),
  };
}

async function enrolledUser(): Promise<{
  cookie: string;
  userId: string;
}> {
  const email = "alice@example.com";
  const { cookie } = await signUpAndSignIn(handle, {
    email,
    password: "Password123!",
    name: "Alice Smith",
  });
  await db
    .update(userTable)
    .set({ username: "alice" })
    .where(eq(userTable.email, email));
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  if (!row) throw new Error("user not created");
  return { cookie, userId: row.id };
}

async function requestDeviceCode() {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/auth/device/code",
    ...form({
      client_id: CLIENT_ID,
      scope: "openid profile offline_access tunnel:serve",
      resource: RELAY_URL,
    }),
  });
  expect(res.statusCode).toBe(200);
  return res.json<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  }>();
}

async function approve(cookie: string, userCode: string) {
  const verify = await handle.app.inject({
    method: "GET",
    url: `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
    headers: { cookie },
  });
  expect(verify.statusCode).toBe(200);
  expect(verify.json<{ status: string }>().status).toBe("pending");

  const res = await handle.app.inject({
    method: "POST",
    url: "/api/auth/device/approve",
    headers: { cookie, "content-type": "application/json" },
    payload: { userCode },
  });
  expect(res.statusCode).toBe(200);
}

async function exchange(deviceCode: string) {
  return handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    ...form({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLIENT_ID,
    }),
  });
}

function decode(token: string) {
  const [header, payload] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header ?? "", "base64url").toString()) as {
      alg: string;
      kid: string;
    },
    payload: JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      aud: string | string[];
      scope: string;
      preferred_username: string;
      exp: number;
      iat: number;
      azp: string;
    },
  };
}

describe("reverse-agent OAuth device grant", () => {
  it("issues an EdDSA JWT bound to the relay with the required claims", async () => {
    const { cookie } = await enrolledUser();
    const grant = await requestDeviceCode();
    expect(grant.verification_uri).toBe("http://localhost:3001/device");
    expect(grant.verification_uri_complete).toContain("user_code=");
    await approve(cookie, grant.user_code);

    const res = await exchange(grant.device_code);
    expect(res.statusCode).toBe(200);
    const tokens = res.json<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }>();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toContain("tunnel:serve");

    const access = decode(tokens.access_token);
    expect(access.header.alg).toBe("EdDSA");
    const audiences = Array.isArray(access.payload.aud)
      ? access.payload.aud
      : [access.payload.aud];
    expect(audiences).toContain(RELAY_URL);
    expect(access.payload.scope).toContain("tunnel:serve");
    expect(access.payload.preferred_username).toBe("alice");
    expect(access.payload.azp).toBe(CLIENT_ID);
    expect(access.payload.exp - access.payload.iat).toBeLessThanOrEqual(900);
    expect(tokens.expires_in).toBeLessThanOrEqual(900);

    const discovery = await handle.app.inject({
      method: "GET",
      url: "/.well-known/openid-configuration",
    });
    const meta = discovery.json<{
      issuer: string;
      jwks_uri: string;
      token_endpoint: string;
      device_authorization_endpoint: string;
    }>();
    expect(meta.issuer).toBe("http://localhost:3001");
    expect(meta.token_endpoint).toContain("/oauth2/token");
    expect(meta.device_authorization_endpoint).toContain("/device/code");
    expect(meta.jwks_uri).toContain("/jwks");
  });

  it("rotates the refresh token and refuses replay", async () => {
    const { cookie } = await enrolledUser();
    const grant = await requestDeviceCode();
    await approve(cookie, grant.user_code);
    const first = await exchange(grant.device_code);
    expect(first.statusCode).toBe(200);
    const initial = first.json<{ refresh_token: string }>();

    const refreshed = await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      ...form({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: CLIENT_ID,
      }),
    });
    expect(refreshed.statusCode).toBe(200);
    const rotated = refreshed.json<{ refresh_token: string }>();
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);

    const replay = await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      ...form({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: CLIENT_ID,
      }),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ error: string }>().error).toBe("invalid_grant");
  });

  it("refuses a revoked refresh token", async () => {
    const { cookie, userId } = await enrolledUser();
    const grant = await requestDeviceCode();
    await approve(cookie, grant.user_code);
    const first = await exchange(grant.device_code);
    const initial = first.json<{ refresh_token: string }>();

    await revokeUserRefreshTokens(userId);
    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      ...form({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: CLIENT_ID,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_grant");
  });

  it("reports access_denied after a denial", async () => {
    const { cookie } = await enrolledUser();
    const grant = await requestDeviceCode();
    const verify = await handle.app.inject({
      method: "GET",
      url: `/api/auth/device?user_code=${encodeURIComponent(grant.user_code)}`,
      headers: { cookie },
    });
    expect(verify.statusCode).toBe(200);
    const deny = await handle.app.inject({
      method: "POST",
      url: "/api/auth/device/deny",
      headers: { cookie, "content-type": "application/json" },
      payload: { userCode: grant.user_code },
    });
    expect(deny.statusCode).toBe(200);

    const res = await exchange(grant.device_code);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("access_denied");
  });

  it("keeps preferred_username globally unique across accounts", async () => {
    const first = await signUpAndSignIn(handle, {
      email: "first@example.com",
      password: "Password123!",
      name: "First",
    });
    const second = await signUpAndSignIn(handle, {
      email: "second@example.com",
      password: "Password123!",
      name: "Second",
    });

    const set = (cookie: string, username: string) =>
      handle.app.inject({
        method: "PATCH",
        url: "/api/user/profile",
        headers: { cookie, "content-type": "application/json" },
        payload: { username },
      });

    expect((await set(first.cookie, "Shared_Name")).statusCode).toBe(200);
    const duplicate = await set(second.cookie, "shared_name");
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe(
      "USR_003",
    );
  });

  it("keeps the client public and linked to the relay resource", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json<{ scopes_supported: string[] }>();
    expect(meta.scopes_supported).toContain("tunnel:serve");

    const [client] = await db
      .select({
        secret: oauthClient.clientSecret,
        method: oauthClient.tokenEndpointAuthMethod,
      })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, CLIENT_ID))
      .limit(1);
    expect(client).toEqual({ secret: null, method: "none" });

    const [resource] = await db
      .select({
        name: oauthResource.name,
        ttl: oauthResource.accessTokenTtl,
      })
      .from(oauthResource)
      .where(eq(oauthResource.identifier, RELAY_URL))
      .limit(1);
    expect(resource).toEqual({ name: "reverse-relay", ttl: 900 });

    const links = await db
      .select({ resourceId: oauthClientResource.resourceId })
      .from(oauthClientResource)
      .where(eq(oauthClientResource.clientId, CLIENT_ID));
    expect(links.map((row) => row.resourceId)).toContain(RELAY_URL);
  });
});
