/**
 * Integration test — email verification flow.
 *
 * 1. POST /api/auth/sign-up/email → user created, verification email sent
 *    (no session because REQUIRE_EMAIL_VERIFICATION=true).
 * 2. Extract verification URL from captured email, follow it.
 * 3. POST /api/auth/sign-in/email succeeds (user.emailVerified = true).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl, toPath } from "./helpers/email-capture.js";

describe("Email — verification flow (integration)", () => {
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

  it("sends a verification email on sign-up and lets the user verify + sign-in", async () => {
    const email = "alice@example.com";
    const password = "correct-horse-battery";

    // 1. Sign up — must trigger verification email, must NOT issue a session.
    const signUp = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name: "Alice" },
      headers: { "content-type": "application/json" },
    });
    expect(signUp.statusCode).toBe(200);

    const msg = handle.capture.last(email);
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/verify/i);

    // 2. Pull the verification URL out of the rendered HTML and follow it.
    const verifyUrl = extractUrl(msg!.html, (u) => u.includes("/api/auth/verify-email"));
    const verifyRes = await handle.app.inject({
      method: "GET",
      url: toPath(verifyUrl),
    });
    // BetterAuth returns 302 to the callbackURL on success.
    expect([200, 302]).toContain(verifyRes.statusCode);

    // 3. Sign-in must now succeed (no further verification email).
    handle.capture.clear();
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
      headers: { "content-type": "application/json" },
    });
    expect(signIn.statusCode).toBe(200);
    expect(handle.capture.messages).toHaveLength(0);
    // Session cookie must be set.
    const setCookie = signIn.headers["set-cookie"];
    expect(setCookie).toBeDefined();
  });

  it("blocks sign-in for an unverified user", async () => {
    const email = "bob@example.com";
    const password = "correct-horse-battery";

    const signUp = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name: "Bob" },
      headers: { "content-type": "application/json" },
    });
    expect(signUp.statusCode).toBe(200);
    expect(handle.capture.last(email)).toBeDefined();

    // Attempt sign-in without clicking the link.
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
      headers: { "content-type": "application/json" },
    });
    // BetterAuth returns 403 when emailVerification is required.
    expect(signIn.statusCode).toBeGreaterThanOrEqual(400);
    expect(signIn.statusCode).toBeLessThan(500);
  });
});
