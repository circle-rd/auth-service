/**
 * Integration tests for the passkey second-factor state machine.
 *
 * A full WebAuthn ceremony needs a real authenticator, which is covered by the
 * browser E2E suite. These tests cover everything up to the assertion: the
 * derived MFA flag, the pending two-factor cookie, method discovery, and the
 * scoped credential list returned to the browser.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import {
  account as accountTable,
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  passkey as passkeyTable,
  session as sessionTable,
  twoFactor as twoFactorTable,
  user as userTable,
  verification as verificationTable,
} from "../db/auth-schema.js";
import { backfillMfaFlags } from "../services/mfa.js";
import { cleanDb } from "./helpers/db.js";
import { cookiesFromResponse } from "./helpers/email-capture.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

let handle: AuthServerHandle;

// Every test performs its own sign-in. Keep each one on a distinct source
// address so the credential rate limiter does not fail the suite on its own
// volume rather than on the code.
let nextAddress = 1;
function freshAddress(): string {
  nextAddress += 1;
  return `10.20.0.${nextAddress}`;
}

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
});

const PASSWORD = "integration-password-123";

async function createUser(
  email: string,
  options: {
    role?: string;
    twoFactorEnabled?: boolean;
    isMfaRequired?: boolean;
  } = {},
): Promise<string> {
  const ctx = await auth.$context;
  const id = `u-${email.split("@")[0]}`;
  await db.insert(userTable).values({
    id,
    name: email,
    email: email.toLowerCase(),
    emailVerified: true,
    role: options.role ?? "user",
    twoFactorEnabled: options.twoFactorEnabled ?? false,
    isMfaRequired: options.isMfaRequired ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await ctx.internalAdapter.createAccount({
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await ctx.password.hash(PASSWORD),
  });
  return id;
}

async function createSocialUser(email: string): Promise<string> {
  const id = `u-${email.split("@")[0]}`;
  await db.insert(userTable).values({
    id,
    name: email,
    email: email.toLowerCase(),
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
    isMfaRequired: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(accountTable).values({
    id: `acc-${id}`,
    userId: id,
    providerId: "google",
    accountId: `google-${id}`,
  });
  return id;
}

async function signInCookie(email: string): Promise<string> {
  const response = await handle.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: email.toLowerCase(), password: PASSWORD },
    remoteAddress: freshAddress(),
    headers: { "content-type": "application/json" },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  }
  return cookiesFromResponse(response.headers["set-cookie"]);
}

async function signInPending(email: string): Promise<{
  cookie: string;
  body: { twoFactorRedirect?: boolean };
}> {
  const response = await handle.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: email.toLowerCase(), password: PASSWORD },
    remoteAddress: freshAddress(),
    headers: { "content-type": "application/json" },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: cookiesFromResponse(response.headers["set-cookie"]),
    body: response.json(),
  };
}

async function addPasskey(userId: string, credentialID = "cred-1") {
  await db.insert(passkeyTable).values({
    id: `pk-${credentialID}`,
    userId,
    credentialID,
    publicKey: "AAAA",
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: "internal",
    createdAt: new Date(),
  });
}

describe("backfillMfaFlags", () => {
  it("aligns the cached flag in both directions", async () => {
    const passkeyUser = await createUser("backfill-passkey@example.com");
    await addPasskey(passkeyUser);

    const totpUser = await createUser("backfill-totp@example.com");
    await db.insert(twoFactorTable).values({
      id: "tf-backfill",
      userId: totpUser,
      secret: "encrypted",
      backupCodes: "encrypted",
      verified: true,
    });

    const staleUser = await createUser("backfill-stale@example.com", {
      twoFactorEnabled: true,
    });

    const socialUser = await createSocialUser("backfill-social@example.com");
    await addPasskey(socialUser, "cred-social");

    const changed = await backfillMfaFlags();
    expect(changed).toBe(3);

    const rows = await db
      .select({
        id: userTable.id,
        twoFactorEnabled: userTable.twoFactorEnabled,
      })
      .from(userTable);
    const byId = new Map(rows.map((row) => [row.id, row.twoFactorEnabled]));
    expect(byId.get(passkeyUser)).toBe(true);
    expect(byId.get(totpUser)).toBe(true);
    expect(byId.get(staleUser)).toBe(false);
    // A social-only passkey owner is not promoted: social login stays usable
    // and the passkey is a primary credential, not a second factor.
    expect(byId.get(socialUser)).toBe(false);
  });
});

describe("GET /api/user/mfa", () => {
  it("requires a session", async () => {
    const response = await handle.app.inject({
      method: "GET",
      url: "/api/user/mfa",
    });
    expect(response.statusCode).toBe(401);
  });

  it("reports passkeys as an MFA method", async () => {
    const userId = await createUser("passkey-only@example.com");
    await addPasskey(userId);
    const cookie = await signInCookie("passkey-only@example.com");

    const response = await handle.app.inject({
      method: "GET",
      url: "/api/user/mfa",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mfaEnabled: true,
      methods: ["passkey"],
      totpRegistered: false,
      passkeyCount: 1,
      backupCodesAvailable: false,
    });
  });

  it("does not count an unverified TOTP setup as MFA", async () => {
    const userId = await createUser("pending-totp@example.com");
    await db.insert(twoFactorTable).values({
      id: "tf-pending",
      userId,
      secret: "encrypted",
      backupCodes: "encrypted",
      verified: false,
    });
    const cookie = await signInCookie("pending-totp@example.com");

    const response = await handle.app.inject({
      method: "GET",
      url: "/api/user/mfa",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mfaEnabled: false,
      methods: [],
      totpRegistered: false,
      passkeyCount: 0,
    });
  });
});

describe("passkey second-factor challenge", () => {
  it("returns the user's passkeys as allowed credentials", async () => {
    const userId = await createUser("pending-passkey@example.com", {
      twoFactorEnabled: true,
    });
    await addPasskey(userId, "cred-1");

    const pending = await signInPending("pending-passkey@example.com");
    expect(pending.body.twoFactorRedirect).toBe(true);

    const methods = await handle.app.inject({
      method: "GET",
      url: "/api/auth/mfa/methods",
      headers: { cookie: pending.cookie },
    });
    expect(methods.statusCode).toBe(200);
    expect(methods.json()).toMatchObject({
      methods: ["passkey"],
      passkeyCount: 1,
      totpRegistered: false,
    });

    const options = await handle.app.inject({
      method: "GET",
      url: "/api/auth/mfa/passkey/options",
      headers: { cookie: pending.cookie },
    });
    expect(options.statusCode).toBe(200);
    const body = options.json<{
      challenge: string;
      allowCredentials: { id: string }[];
    }>();
    expect(body.challenge).toBeTypeOf("string");
    expect(body.allowCredentials[0]).toMatchObject({
      id: "cred-1",
      type: "public-key",
    });

    const challengeCookie = cookiesFromResponse(options.headers["set-cookie"]);
    const verify = await handle.app.inject({
      method: "POST",
      url: "/api/auth/mfa/passkey/verify-authentication",
      headers: {
        cookie: `${pending.cookie}; ${challengeCookie}`,
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      payload: {
        response: {
          id: "cred-1",
          rawId: "cred-1",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: "AAAA",
            authenticatorData: "AAAA",
            signature: "AAAA",
          },
        },
      },
    });
    expect(verify.statusCode).toBe(401);
    expect(verify.json()).toMatchObject({
      code: "MFA_005",
    });
  });

  it("rejects the options endpoint without a pending sign-in", async () => {
    const response = await handle.app.inject({
      method: "GET",
      url: "/api/auth/mfa/passkey/options",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "MFA_001",
    });
  });
});

describe("passkey deletion policy", () => {
  it("refuses to remove the last MFA method when MFA is required", async () => {
    const userId = await createUser("policy-required@example.com", {
      isMfaRequired: true,
    });
    await addPasskey(userId);
    const cookie = await signInCookie("policy-required@example.com");

    const response = await handle.app.inject({
      method: "POST",
      url: "/api/auth/passkey/delete-passkey",
      headers: { cookie },
      payload: { id: "pk-cred-1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MFA_009" });
    expect(
      await db
        .select()
        .from(passkeyTable)
        .where(eq(passkeyTable.userId, userId)),
    ).toHaveLength(1);
  });

  it("allows removal when a password remains the primary method", async () => {
    const userId = await createUser("policy-optional@example.com");
    await addPasskey(userId);
    const cookie = await signInCookie("policy-optional@example.com");

    const response = await handle.app.inject({
      method: "POST",
      url: "/api/auth/passkey/delete-passkey",
      headers: { cookie },
      payload: { id: "pk-cred-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(
      await db
        .select()
        .from(passkeyTable)
        .where(eq(passkeyTable.userId, userId)),
    ).toHaveLength(0);
  });
});

describe("passkey deletion policy with several credentials", () => {
  it("allows deleting one of several passkeys when MFA is required", async () => {
    const userId = await createUser("policy-multi@example.com", {
      isMfaRequired: true,
    });
    await addPasskey(userId, "cred-1");
    await addPasskey(userId, "cred-2");
    const cookie = await signInCookie("policy-multi@example.com");

    const response = await handle.app.inject({
      method: "POST",
      url: "/api/auth/passkey/delete-passkey",
      headers: { cookie },
      payload: { id: "pk-cred-1" },
    });

    expect(response.statusCode).toBe(200);
    const remaining = await db
      .select()
      .from(passkeyTable)
      .where(eq(passkeyTable.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.credentialID).toBe("cred-2");
  });
});

describe("POST /api/admin/users/:id/mfa/reset", () => {
  it("removes every factor and clears the derived flag", async () => {
    const adminId = await createUser("reset-admin@example.com", {
      role: "superadmin",
    });
    const targetId = await createUser("reset-target@example.com", {
      twoFactorEnabled: true,
      isMfaRequired: true,
    });
    await addPasskey(targetId);
    await db.insert(twoFactorTable).values({
      id: "tf-target",
      userId: targetId,
      secret: "encrypted",
      backupCodes: "encrypted",
      verified: true,
    });
    await db.insert(verificationTable).values([
      {
        id: "v-trust",
        identifier: "trust-device-test",
        value: targetId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        id: "v-2fa",
        identifier: "2fa-test",
        value: targetId,
        expiresAt: new Date(Date.now() + 600_000),
      },
    ]);

    await db.insert(oauthClient).values({
      id: "oc_reset",
      clientId: "reset-client",
      redirectUris: [],
      scopes: ["openid"],
    });
    await db.insert(sessionTable).values([
      {
        id: "sess-target",
        token: "token-target",
        userId: targetId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        id: "sess-admin",
        token: "token-admin",
        userId: adminId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    await db.insert(oauthRefreshToken).values({
      id: "rt-target",
      token: "refresh-target",
      clientId: "reset-client",
      userId: targetId,
      sessionId: "sess-target",
      scopes: ["openid"],
    });
    await db.insert(oauthAccessToken).values({
      id: "at-target",
      token: "access-target",
      clientId: "reset-client",
      userId: targetId,
      sessionId: "sess-target",
      scopes: ["openid"],
    });

    const cookie = await signInCookie("reset-admin@example.com");
    const response = await handle.app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/mfa/reset`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      mfa: { mfaEnabled: false, methods: [], totpRegistered: false, passkeyCount: 0 },
    });

    const [target] = await db
      .select({ twoFactorEnabled: userTable.twoFactorEnabled })
      .from(userTable)
      .where(eq(userTable.id, targetId));
    expect(target?.twoFactorEnabled).toBe(false);
    expect(
      await db.select().from(passkeyTable).where(eq(passkeyTable.userId, targetId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(twoFactorTable)
        .where(eq(twoFactorTable.userId, targetId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(verificationTable)
        .where(eq(verificationTable.value, targetId)),
    ).toHaveLength(0);
    // The caller's own session must survive a reset of another account.
    const adminAccount = await db
      .select()
      .from(accountTable)
      .where(eq(accountTable.userId, adminId));
    expect(adminAccount).toHaveLength(1);

    const targetSessions = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.userId, targetId));
    expect(targetSessions).toHaveLength(0);
    const adminSessions = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.userId, adminId));
    expect(adminSessions.length).toBeGreaterThan(0);

    const [refresh] = await db
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, targetId));
    expect(refresh?.revoked).not.toBeNull();
    expect(
      await db
        .select()
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.userId, targetId)),
    ).toHaveLength(0);
  });

  it("keeps a passwordless user's primary passkey", async () => {
    const adminId = await createUser("reset-admin-2@example.com", {
      role: "superadmin",
    });
    const targetId = await createSocialUser("reset-social@example.com");
    await addPasskey(targetId);

    const cookie = await signInCookie("reset-admin-2@example.com");
    const response = await handle.app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/mfa/reset`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const remaining = await db
      .select()
      .from(passkeyTable)
      .where(eq(passkeyTable.userId, targetId));
    expect(remaining).toHaveLength(1);
    expect(adminId).toBeTruthy();
  });
});