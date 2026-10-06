/**
 * Integration test — administrator-initiated password reset.
 *
 * The credential write and the session/token revocation are one operation on
 * `POST /api/admin/users/:id/set-password`: a reset that left the target's
 * existing sessions alive would be useless against a compromised account, so
 * the revocation is asserted on a session cookie captured BEFORE the call.
 *
 * Sessions are minted through `auth.api.signInEmail` rather than HTTP sign-ins:
 * the Fastify auth-rate bucket is per IP and allows 10 credential attempts a
 * minute, which a per-role matrix exhausts. These are still real BetterAuth
 * sessions carried by real signed cookies.
 *
 * The hierarchy rule under test is the STRICT one (`canManageRole`): a caller
 * may only target a user of strictly lower rank, so a superadmin may not reset
 * another superadmin's password.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { cookiesFromResponse } from "./helpers/email-capture.js";
import { db } from "../db/index.js";
import {
  oauthClient,
  oauthRefreshToken,
  session as sessionTable,
  user as userTable,
} from "../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { cleanDb } from "./helpers/db.js";
import { auth } from "../auth.js";

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

const NEW_PASSWORD = "new-password-45678";

/**
 * Domain error code of a failed response. The running server serialises
 * `ApiError` through Fastify's default handler, which puts the code at the top
 * level (`{ statusCode, code, message }`).
 */
function errorCode(body: string): string | undefined {
  const parsed = JSON.parse(body) as {
    code?: string;
    error?: { code?: string };
  };
  return parsed.error?.code ?? parsed.code;
}

/** Create a verified user with a credential account, directly. */
async function createUser(
  email: string,
  password: string,
  role: string,
): Promise<string> {
  const ctx = await auth.$context;
  const id = `u-${email.split("@")[0]}`;
  await db.insert(userTable).values({
    id,
    name: email,
    email: email.toLowerCase(),
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await ctx.internalAdapter.createAccount({
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await ctx.password.hash(password),
  });
  return id;
}

/** Sign in through BetterAuth and return the signed session cookie header. */
async function signInCookie(email: string, password: string): Promise<string> {
  const result = (await auth.api.signInEmail({
    body: { email: email.toLowerCase(), password },
    returnHeaders: true,
  })) as unknown as { headers: Headers };
  const cookie = cookiesFromResponse(result.headers.getSetCookie());
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

/** A caller of the given role plus their session cookie. */
async function caller(role: string): Promise<{ cookie: string; id: string }> {
  const email = `${role}1@example.com`;
  const password = "caller-password-1234";
  const id = await createUser(email, password, role);
  return { cookie: await signInCookie(email, password), id };
}

function setPassword(
  cookie: string,
  targetId: string,
  newPassword: string = NEW_PASSWORD,
) {
  return handle.app.inject({
    method: "POST",
    url: `/api/admin/users/${targetId}/set-password`,
    headers: { cookie, "content-type": "application/json" },
    payload: { newPassword },
  });
}

/** Whether the given session cookie still authenticates. */
async function sessionIsValid(cookie: string): Promise<boolean> {
  const res = await handle.app.inject({
    method: "GET",
    url: "/api/auth/get-session",
    headers: { cookie },
  });
  if (res.statusCode !== 200) return false;
  return res.json<unknown>() !== null;
}

describe("Admin password reset — hierarchy (integration)", () => {
  it("admin → user succeeds", async () => {
    const admin = await caller("admin");
    const target = await createUser(
      "user@example.com",
      "x-password-1234",
      "user",
    );

    const res = await setPassword(admin.cookie, target);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("admin → admin is refused", async () => {
    const admin = await caller("admin");
    const peer = await createUser(
      "peer@example.com",
      "x-password-1234",
      "admin",
    );

    const res = await setPassword(admin.cookie, peer);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe("AUTH_011");
  });

  it("admin → superadmin is refused", async () => {
    const admin = await caller("admin");
    const root = await createUser(
      "root@example.com",
      "x-password-1234",
      "superadmin",
    );

    const res = await setPassword(admin.cookie, root);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe("AUTH_011");
  });

  it("superadmin → user succeeds", async () => {
    const sa = await caller("superadmin");
    const target = await createUser(
      "user@example.com",
      "x-password-1234",
      "user",
    );

    expect((await setPassword(sa.cookie, target)).statusCode).toBe(200);
  });

  it("superadmin → admin succeeds", async () => {
    const sa = await caller("superadmin");
    const target = await createUser(
      "admin2@example.com",
      "x-password-1234",
      "admin",
    );

    expect((await setPassword(sa.cookie, target)).statusCode).toBe(200);
  });

  it("superadmin → superadmin is refused (strict rule, no peer targeting)", async () => {
    const sa = await caller("superadmin");
    const peer = await createUser(
      "peer-sa@example.com",
      "x-password-1234",
      "superadmin",
    );

    const res = await setPassword(sa.cookie, peer);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe("AUTH_011");
  });

  it("refuses an unauthenticated caller", async () => {
    const target = await createUser(
      "user@example.com",
      "x-password-1234",
      "user",
    );
    const res = await handle.app.inject({
      method: "POST",
      url: `/api/admin/users/${target}/set-password`,
      headers: { "content-type": "application/json" },
      payload: { newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 for an unknown target", async () => {
    const sa = await caller("superadmin");
    const res = await setPassword(sa.cookie, "does-not-exist");
    expect(res.statusCode).toBe(404);
    expect(errorCode(res.body)).toBe("USR_001");
  });
});

describe("Admin password reset — session revocation (integration)", () => {
  it("invalidates a session cookie captured before the reset", async () => {
    const sa = await caller("superadmin");
    const victimId = await createUser(
      "victim@example.com",
      "victim-password-1234",
      "user",
    );
    const victimCookie = await signInCookie(
      "victim@example.com",
      "victim-password-1234",
    );

    // Precondition: the session is live.
    expect(await sessionIsValid(victimCookie)).toBe(true);

    const res = await setPassword(sa.cookie, victimId);
    expect(res.statusCode).toBe(200);

    // The central assertion: the captured session no longer authenticates.
    expect(await sessionIsValid(victimCookie)).toBe(false);

    // Not merely a dangling cookie — the session rows are gone.
    const remaining = await db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.userId, victimId));
    expect(remaining).toHaveLength(0);
  });

  it("lets the target sign in with the new password and spares the caller", async () => {
    const sa = await caller("superadmin");
    const victimId = await createUser(
      "victim@example.com",
      "victim-password-1234",
      "user",
    );
    await signInCookie("victim@example.com", "victim-password-1234");

    expect((await setPassword(sa.cookie, victimId)).statusCode).toBe(200);

    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email: "victim@example.com", password: NEW_PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    // Only the target is revoked: the caller keeps their session.
    expect(await sessionIsValid(sa.cookie)).toBe(true);
  });

  it("revokes the target's OAuth refresh tokens too (separate credential store)", async () => {
    const sa = await caller("superadmin");
    const victimId = await createUser(
      "victim@example.com",
      "victim-password-1234",
      "user",
    );

    // A refresh token for the victim, as if one were still in the wild.
    await db.insert(oauthClient).values({
      id: "client-1",
      clientId: "app-slug",
      redirectUris: ["https://example.com/cb"],
    });
    await db.insert(oauthRefreshToken).values({
      id: "rt-1",
      token: "refresh-token-value",
      clientId: "app-slug",
      userId: victimId,
      scopes: [],
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    });

    expect((await setPassword(sa.cookie, victimId)).statusCode).toBe(200);

    const [row] = await db
      .select({ revoked: oauthRefreshToken.revoked })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.id, "rt-1"))
      .limit(1);
    expect(row?.revoked).not.toBeNull();
  });
});

describe("Admin password reset — password policy (integration)", () => {
  it("refuses a too-short password with the domain error, not a crash", async () => {
    const sa = await caller("superadmin");
    const target = await createUser(
      "user@example.com",
      "x-password-1234",
      "user",
    );

    const res = await setPassword(sa.cookie, target, "short");
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe("AUTH_009");
  });

  it("accepts a password at the minimum length", async () => {
    const sa = await caller("superadmin");
    const target = await createUser(
      "user@example.com",
      "x-password-1234",
      "user",
    );

    expect((await setPassword(sa.cookie, target, "12345678")).statusCode).toBe(
      200,
    );
  });

  it("refuses an empty password", async () => {
    const sa = await caller("superadmin");
    const target = await createUser(
      "user@example.com",
      "x-password-1234",
      "user",
    );

    expect((await setPassword(sa.cookie, target, "")).statusCode).toBe(400);
  });
});
