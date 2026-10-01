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
import { cleanDb } from "./helpers/db.js";
import { extractUrl, toPath } from "./helpers/email-capture.js";

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

async function promote(email: string, role: string): Promise<void> {
  await db
    .update(userTable)
    .set({ role })
    .where(eq(userTable.email, email));
}

async function seedUser(
  id: string,
  email: string,
  role: string,
): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: id,
    email,
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function jsonHeaders(cookie?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
  };
}

describe("security hardening – native admin hierarchy", () => {
  it("denies an admin banning a superadmin", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "Password123!",
      name: "Admin",
    });
    await promote("admin@example.com", "admin");
    await seedUser("sa-1", "sa@example.com", "superadmin");

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/admin/ban-user",
      headers: jsonHeaders(cookie),
      payload: { userId: "sa-1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies an admin revoking a superadmin's sessions", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "Password123!",
      name: "Admin",
    });
    await promote("admin@example.com", "admin");
    await seedUser("sa-1", "sa@example.com", "superadmin");

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/admin/revoke-user-sessions",
      headers: jsonHeaders(cookie),
      payload: { userId: "sa-1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows an admin banning a regular user", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "Password123!",
      name: "Admin",
    });
    await promote("admin@example.com", "admin");
    await seedUser("u-1", "u1@example.com", "user");

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/admin/ban-user",
      headers: jsonHeaders(cookie),
      payload: { userId: "u-1" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("security hardening – self-service fields", () => {
  it("ignores a user trying to set isMfaRequired on themselves", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "user@example.com",
      password: "Password123!",
      name: "User",
    });

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers: jsonHeaders(cookie),
      payload: { isMfaRequired: true },
    });
    // `input: false` makes the field non-writable through this endpoint: the
    // request is either ignored (200) or rejected as invalid input (400).
    expect([200, 400]).toContain(res.statusCode);

    const [row] = await db
      .select({ isMfaRequired: userTable.isMfaRequired })
      .from(userTable)
      .where(eq(userTable.email, "user@example.com"))
      .limit(1);
    expect(row?.isMfaRequired).toBe(false);
  });
});

describe("security hardening – passwordless 2FA bypass", () => {
  it("blocks magic-link sign-in for a 2FA-enabled account", async () => {
    // Insert directly to avoid extra sign-in requests hitting the auth rate
    // limit for this file.
    await db.insert(userTable).values({
      id: "mfa-1",
      name: "MFA",
      email: "mfa@example.com",
      emailVerified: true,
      role: "user",
      twoFactorEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    handle.capture.clear();

    const req = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      payload: { email: "mfa@example.com", callbackURL: "/" },
      headers: { "content-type": "application/json" },
    });
    expect(req.statusCode).toBe(200);

    const msg = handle.capture.last("mfa@example.com");
    expect(msg).toBeDefined();
    const link = extractUrl(msg!.html, (u) =>
      u.includes("/api/auth/magic-link/verify"),
    );
    const followed = await handle.app.inject({
      method: "GET",
      url: toPath(link),
    });
    // The session created by the magic-link verify is dropped and the request
    // rejected because the account requires a second factor.
    expect(followed.statusCode).toBe(403);
  });
});

describe("security hardening – OAuth client registration", () => {
  it("denies a regular user creating an OAuth client", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "user@example.com",
      password: "Password123!",
      name: "User",
    });

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/oauth2/create-client",
      headers: jsonHeaders(cookie),
      payload: { redirect_uris: ["https://example.com/cb"] },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
