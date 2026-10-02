/**
 * Integration test — admin-created users receive a verification email.
 *
 * The native BetterAuth `/admin/create-user` endpoint does not trigger the
 * `sendOnSignUp` verification mail. `POST /api/admin/users` must send it
 * explicitly, and expose resend / mark-verified actions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";

/** Poll until `fn` returns a truthy value (the admin-create send is detached). */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for email");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Email — admin-created user (integration)", () => {
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

  async function seedSuperadminCookie(): Promise<string> {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "correct-horse-battery",
      name: "Admin",
    });
    await db
      .update(userTable)
      .set({ role: "superadmin" })
      .where(eq(userTable.email, "admin@example.com"));
    handle.capture.clear();
    return cookie;
  }

  it("sends a verification email when an admin creates a user", async () => {
    const cookie = await seedSuperadminCookie();

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        name: "New User",
        email: "newuser@example.com",
        password: "another-strong-pass",
      },
    });
    expect(res.statusCode).toBe(201);

    const msg = await waitFor(() => handle.capture.last("newuser@example.com"));
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/verify/i);
    expect(
      handle.capture.messages.filter((m) => m.to === "newuser@example.com"),
    ).toHaveLength(1);

    const created = res.json<{ user: { id: string; emailVerified: boolean } }>();
    expect(created.user.emailVerified).toBe(false);
  });

  it("allows an admin to resend and then mark the address verified", async () => {
    const cookie = await seedSuperadminCookie();

    const create = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        name: "New User",
        email: "newuser2@example.com",
        password: "another-strong-pass",
      },
    });
    expect(create.statusCode).toBe(201);
    const userId = create.json<{ user: { id: string } }>().user.id;
    handle.capture.clear();

    const resend = await handle.app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/send-verification`,
      headers: { cookie },
    });
    expect(resend.statusCode).toBe(200);
    expect(handle.capture.last("newuser2@example.com")).toBeDefined();

    // Re-sending reverts the account to unverified.
    const [afterResend] = await db
      .select({ emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    expect(afterResend?.emailVerified).toBe(false);

    const verify = await handle.app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/verify-email`,
      headers: { cookie },
    });
    expect(verify.statusCode).toBe(200);

    const [row] = await db
      .select({ emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    expect(row?.emailVerified).toBe(true);
  });
});
