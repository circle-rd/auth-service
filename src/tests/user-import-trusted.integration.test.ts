import { pbkdf2Sync, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { account, user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";

let handle: AuthServerHandle;
let superadminCookie: string;
let adminCookie: string;

// Sign-ups and sign-ins share a small per-address rate limit, so the two
// administrators are created once for the whole file.
beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
  superadminCookie = await signInAs("superadmin");
  adminCookie = await signInAs("admin");
});

afterAll(async () => {
  await handle.cleanup();
});

async function signInAs(role: "superadmin" | "admin"): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email: `${role}@example.com`,
    password: "Password123!",
    name: role,
  });
  await db
    .update(userTable)
    .set({ role })
    .where(eq(userTable.email, `${role}@example.com`));
  return cookie;
}

function importUsers(cookie: string, payload: unknown) {
  return handle.app.inject({
    method: "POST",
    url: "/api/admin/users/import",
    headers: { cookie, "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });
}

function signIn(email: string, password: string) {
  return handle.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { "content-type": "application/json" },
    payload: { email, password },
  });
}

async function storedPassword(email: string): Promise<string | null> {
  const [row] = await db
    .select({ password: account.password })
    .from(account)
    .innerJoin(userTable, eq(userTable.id, account.userId))
    .where(eq(userTable.email, email));
  return row?.password ?? null;
}

describe("trusted user import", () => {
  it("keeps the imported id and lets a bcrypt user sign in, then upgrades the hash", async () => {
    const cookie = superadminCookie;
    const hash = bcrypt.hashSync("Legacy-Pass-1", 10);

    const res = await importUsers(cookie, {
      users: [
        {
          id: "auth0|abc123",
          name: "Alice",
          email: "Alice@Example.com",
          emailVerified: true,
          passwordHash: { algorithm: "bcrypt", hash },
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      created: number;
      results: { status: string; password?: string }[];
    };
    expect(body.created).toBe(1);
    expect(body.results[0]?.password).toBeUndefined();

    const [row] = await db
      .select({ id: userTable.id, verified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, "alice@example.com"));
    expect(row).toEqual({ id: "auth0|abc123", verified: true });
    expect(await storedPassword("alice@example.com")).toBe(hash);

    expect(
      (await signIn("alice@example.com", "wrong-password")).statusCode,
    ).toBe(401);
    expect(
      (await signIn("alice@example.com", "Legacy-Pass-1")).statusCode,
    ).toBe(200);

    // The imported hash was replaced by a native one, which keeps working.
    const upgraded = await storedPassword("alice@example.com");
    expect(upgraded).not.toBe(hash);
    expect(upgraded).not.toMatch(/^\$2/);
    expect(
      (await signIn("alice@example.com", "Legacy-Pass-1")).statusCode,
    ).toBe(200);
  });

  it("accepts a PBKDF2 hash such as the ones Keycloak stores", async () => {
    const cookie = superadminCookie;
    const salt = randomBytes(16);
    const derived = pbkdf2Sync("Keycloak-Pass-1", salt, 27500, 64, "sha512");

    const res = await importUsers(cookie, {
      users: [
        {
          name: "Bob",
          email: "bob@example.com",
          emailVerified: true,
          passwordHash: {
            algorithm: "pbkdf2",
            digest: "sha512",
            iterations: 27500,
            salt: salt.toString("base64"),
            hash: derived.toString("base64"),
          },
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(
      (await signIn("bob@example.com", "Keycloak-Pass-1")).statusCode,
    ).toBe(200);
    expect(await storedPassword("bob@example.com")).not.toMatch(/^pbkdf2\$/);
  });

  it("creates a verified user without password and sends no mail on request", async () => {
    const cookie = superadminCookie;
    handle.capture.clear();

    const res = await importUsers(cookie, {
      sendVerification: false,
      users: [
        { id: "00u1abc", name: "Carol", email: "carol@example.com" },
        { id: "00u2abc", name: "Dan", email: "dan@example.com", emailVerified: true },
      ],
    });
    const body = JSON.parse(res.body) as {
      results: { email: string; password?: string }[];
    };
    expect(body.results.every((r) => typeof r.password === "string")).toBe(true);
    expect(handle.capture.last("carol@example.com")).toBeUndefined();
  });

  it("refuses ids, verification state and hashes from a plain admin", async () => {
    const cookie = adminCookie;
    const res = await importUsers(cookie, {
      users: [
        { id: "x1", name: "Eve", email: "eve@example.com" },
        { name: "Frank", email: "frank@example.com", emailVerified: true },
        { name: "Grace", email: "grace@example.com" },
      ],
    });
    const body = JSON.parse(res.body) as {
      created: number;
      results: { email: string; status: string }[];
    };
    expect(body.created).toBe(1);
    expect(body.results.map((r) => r.status)).toEqual([
      "error",
      "error",
      "created",
    ]);
  });

  it("reports an existing e-mail or id as a row error", async () => {
    const cookie = superadminCookie;
    const row = { id: "dup-1", name: "Hank", email: "hank@example.com" };
    await importUsers(cookie, { users: [row] });

    const again = await importUsers(cookie, {
      users: [row, { id: "dup-1", name: "Other", email: "other@example.com" }],
    });
    const body = JSON.parse(again.body) as {
      failed: number;
      results: { message?: string }[];
    };
    expect(body.failed).toBe(2);
    expect(body.results[0]?.message).toMatch(/already exists/);
  });

  it.each([
    [{ algorithm: "bcrypt", hash: "not-a-hash" }],
    [
      {
        algorithm: "pbkdf2",
        digest: "md5",
        iterations: 1000,
        salt: "c2FsdA==",
        hash: "aGFzaA==",
      },
    ],
    [
      {
        algorithm: "pbkdf2",
        digest: "sha256",
        iterations: 50_000_000,
        salt: "c2FsdA==",
        hash: "aGFzaA==",
      },
    ],
  ])("rejects a malformed or unbounded hash", async (passwordHash) => {
    const cookie = superadminCookie;
    const res = await importUsers(cookie, {
      users: [{ name: "Ivy", email: "ivy@example.com", passwordHash }],
    });
    expect(res.statusCode).toBe(400);
  });
});
