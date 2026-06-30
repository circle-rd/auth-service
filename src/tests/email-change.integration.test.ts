/**
 * Integration test — change-email flow.
 *
 * 1. Sign up + verify a user.
 * 2. POST /api/auth/change-email with a new address (requires session).
 * 3. Verification email is sent to the CURRENT address; follow it.
 * 4. User's email row is updated to the new value.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl, toPath } from "./helpers/email-capture.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";

describe("Email — change-email flow (integration)", () => {
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

  it("emails the current address with a confirmation link that updates the user row", async () => {
    const oldEmail = "dave@example.com";
    const newEmail = "dave2@example.com";
    const password = "good-password-12345";
    const { cookie } = await signUpAndSignIn(handle, {
      email: oldEmail,
      password,
      name: "Dave",
    });

    const req = await handle.app.inject({
      method: "POST",
      url: "/api/auth/change-email",
      payload: { newEmail, callbackURL: "/" },
      headers: { "content-type": "application/json", cookie },
    });
    expect(req.statusCode).toBe(200);

    // Step 1 — confirmation link sent to the CURRENT address. Follow it.
    const confirm = handle.capture.last(oldEmail);
    expect(confirm).toBeDefined();
    expect(confirm!.html).toContain(newEmail);
    const confirmUrl = extractUrl(confirm!.html, (u) =>
      u.includes("/api/auth/verify-email"),
    );
    const confirmRes = await handle.app.inject({
      method: "GET",
      url: toPath(confirmUrl),
    });
    expect([200, 302]).toContain(confirmRes.statusCode);

    // Step 2 — BetterAuth then sends a verification email to the NEW
    // address. Following that one is what actually swaps the user row.
    const verify = handle.capture.last(newEmail);
    expect(verify).toBeDefined();
    const verifyUrl = extractUrl(verify!.html, (u) =>
      u.includes("/api/auth/verify-email"),
    );
    const verifyRes = await handle.app.inject({
      method: "GET",
      url: toPath(verifyUrl),
    });
    expect([200, 302]).toContain(verifyRes.statusCode);

    const [updated] = await db
      .select({ email: userTable.email })
      .from(userTable)
      .where(eq(userTable.email, newEmail));
    expect(updated?.email).toBe(newEmail);
  });
});
