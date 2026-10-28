/**
 * Integration test — OIDC Back-Channel Logout.
 *
 * The provider plugin already ships the mechanism; this pins the contract the
 * admin surface now exposes: ending a session revokes the session-bound access
 * tokens and refresh tokens (sparing `offline_access`) and POSTs a signed
 * logout token to each eligible relying party.
 *
 * The receiver is a plain HTTP server: the plugin validates the URI on
 * registration (https) but does not re-validate at delivery, so the test writes
 * a loopback URI directly to exercise the delivery path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { applications, userApplications } from "../db/schema.js";
import {
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  user as userTable,
} from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";

const REDIRECT = "https://app.example.com/callback";
const APP_URL = "https://app.example.com";
const APP_SLUG = "bc-app";
const PASSWORD = "Password123!";
const JSON_HEADERS = { "content-type": "application/json" };
const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";

const basic = (id: string, secret: string) =>
  "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

function decodeJwt(jwt: string) {
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

describe("Back-channel logout (integration)", () => {
  let handle: AuthServerHandle;
  let receiver: Server;
  let receiverUrl: string;
  const received: string[] = [];

  let adminCookie: string;
  let clientSecret: string;
  let userCookie: string;
  let sessionId: string;

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const port = (receiver.address() as AddressInfo).port;
    receiverUrl = `http://127.0.0.1:${port}/bc`;

    handle = await makeAuthServer();
    await cleanDb();

    const admin = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: PASSWORD,
      name: "Admin",
    });
    adminCookie = admin.cookie;
    await db
      .update(userTable)
      .set({ role: "superadmin" })
      .where(eq(userTable.email, "admin@example.com"));

    const created = await handle.app.inject({
      method: "POST",
      url: "/api/admin/applications",
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: {
        name: "Back-channel app",
        slug: APP_SLUG,
        url: APP_URL,
        redirectUris: [REDIRECT],
        skipConsent: true,
        allowedScopes: ["openid", "profile", "email", "offline_access"],
      },
    });
    expect(created.statusCode).toBe(201);
    clientSecret = created.json<{ clientSecret: string }>().clientSecret;

    // Point the registered client at the loopback receiver.
    await db
      .update(oauthClient)
      .set({
        backchannelLogoutUri: receiverUrl,
        backchannelLogoutSessionRequired: true,
      })
      .where(eq(oauthClient.clientId, APP_SLUG));

    const user = await signUpAndSignIn(handle, {
      email: "user@example.com",
      password: PASSWORD,
      name: "User",
    });
    userCookie = user.cookie;

    // Token issuance requires the user to hold access to the application.
    const [userRow] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, "user@example.com"))
      .limit(1);
    const [appRow] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, APP_SLUG))
      .limit(1);
    await db
      .insert(userApplications)
      .values({
        userId: userRow!.id,
        applicationId: appRow!.id,
        isActive: true,
      })
      .onConflictDoNothing();

    const session = await handle.app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: userCookie },
    });
    sessionId = session.json<{ session: { id: string } }>().session.id;
  });

  afterAll(async () => {
    await handle.cleanup();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  const mintTokens = async (scope: string) => {
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await handle.app.inject({
      method: "GET",
      url:
        "/api/auth/oauth2/authorize?" +
        new URLSearchParams({
          client_id: APP_SLUG,
          response_type: "code",
          redirect_uri: REDIRECT,
          scope,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        }),
      headers: { cookie: userCookie },
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
        authorization: basic(APP_SLUG, clientSecret),
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    return token.json<{ access_token: string; refresh_token?: string }>();
  };

  it("advertises back-channel logout support", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/.well-known/openid-configuration",
    });
    const meta = res.json<{
      backchannel_logout_supported: boolean;
      backchannel_logout_session_supported: boolean;
    }>();
    expect(meta.backchannel_logout_supported).toBe(true);
    expect(meta.backchannel_logout_session_supported).toBe(true);
  });

  it("posts a logout token and revokes session-bound tokens, sparing offline_access", async () => {
    const online = await mintTokens("openid");
    const offline = await mintTokens("openid offline_access");
    expect(offline.refresh_token).toBeTruthy();
    expect(online.refresh_token).toBeFalsy(); // OIDC: refresh needs offline_access
    received.length = 0;

    const signOut = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: userCookie },
    });
    expect(signOut.statusCode).toBe(200);

    // One eligible relying party → exactly one delivery.
    expect(received).toHaveLength(1);
    const token = new URLSearchParams(received[0]).get("logout_token");
    expect(token).toBeTruthy();
    const { header, payload } = decodeJwt(token!);
    expect(header.typ).toBe("logout+jwt");
    expect(payload.aud).toBe(APP_SLUG);
    expect(payload.sid).toBe(sessionId);
    expect(payload).not.toHaveProperty("nonce");
    expect(payload.events).toMatchObject({ [BACKCHANNEL_EVENT]: {} });

    // Every access token this client holds is revoked.
    const access = await db
      .select({ revoked: oauthAccessToken.revoked })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, APP_SLUG));
    expect(access.length).toBe(2);
    expect(access.every((row) => row.revoked !== null)).toBe(true);

    // The offline_access refresh token survives the logout (OIDC semantics).
    const refresh = await db
      .select({ revoked: oauthRefreshToken.revoked })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.clientId, APP_SLUG));
    expect(refresh).toHaveLength(1);
    expect(refresh[0]?.revoked ?? null).toBeNull();
  });

  it("validates the back-channel settings through the admin API", async () => {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, APP_SLUG))
      .limit(1);

    const rejected = await handle.app.inject({
      method: "PATCH",
      url: `/api/admin/applications/${app!.id}`,
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { backchannelLogoutUri: "http://app.example.com/bc" },
    });
    expect(rejected.statusCode).toBe(400);

    // The provider delivers from the auth-service host: a URI pointing at this
    // machine or at link-local services (cloud metadata) is refused.
    for (const local of [
      "https://localhost/bc",
      "https://127.0.0.1/bc",
      "https://169.254.169.254/bc",
    ]) {
      const blocked = await handle.app.inject({
        method: "PATCH",
        url: `/api/admin/applications/${app!.id}`,
        headers: { cookie: adminCookie, ...JSON_HEADERS },
        payload: { backchannelLogoutUri: local },
      });
      expect(blocked.statusCode).toBe(400);
    }

    // An internal address is legitimate: split-horizon DNS answers a private
    // IP for the application's public name.
    const internal = await handle.app.inject({
      method: "PATCH",
      url: `/api/admin/applications/${app!.id}`,
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { backchannelLogoutUri: "https://10.0.0.5/bc" },
    });
    expect(internal.statusCode).toBe(200);

    const accepted = await handle.app.inject({
      method: "PATCH",
      url: `/api/admin/applications/${app!.id}`,
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: {
        backchannelLogoutUri: "https://203.0.113.10/bc",
        backchannelLogoutSessionRequired: true,
      },
    });
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json<{
      application: {
        backchannelLogoutUri: string | null;
        backchannelLogoutSessionRequired: boolean;
      };
    }>();
    expect(body.application.backchannelLogoutUri).toBe(
      "https://203.0.113.10/bc",
    );
    expect(body.application.backchannelLogoutSessionRequired).toBe(true);

    const [row] = await db
      .select({
        uri: oauthClient.backchannelLogoutUri,
        required: oauthClient.backchannelLogoutSessionRequired,
      })
      .from(oauthClient)
      .where(
        and(eq(oauthClient.clientId, APP_SLUG), eq(oauthClient.disabled, false)),
      )
      .limit(1);
    expect(row?.uri).toBe("https://203.0.113.10/bc");
    expect(row?.required).toBe(true);
  });

  it("leaves fields omitted from a partial update untouched", async () => {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, APP_SLUG))
      .limit(1);
    const url = `/api/admin/applications/${app!.id}`;

    const set = await handle.app.inject({
      method: "PATCH",
      url,
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { allowRegister: true, backchannelLogoutSessionRequired: true },
    });
    expect(set.statusCode).toBe(200);

    // A partial update must not reset the fields it omits to their schema
    // defaults; only `description` is being changed here.
    const partial = await handle.app.inject({
      method: "PATCH",
      url,
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { description: "renamed only" },
    });
    expect(partial.statusCode).toBe(200);
    const body = partial.json<{
      application: {
        allowRegister: boolean;
        backchannelLogoutSessionRequired: boolean;
        description: string | null;
      };
    }>();
    expect(body.application.description).toBe("renamed only");
    expect(body.application.allowRegister).toBe(true);
    expect(body.application.backchannelLogoutSessionRequired).toBe(true);
  });
});
