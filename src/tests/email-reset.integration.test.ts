/**
 * Integration test — password reset flow.
 *
 * 1. Sign up + verify a user.
 * 2. POST /api/auth/request-password-reset → reset email captured.
 * 3. Extract URL, derive token, POST /api/auth/reset-password.
 * 4. Sign in with the new password — must succeed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl } from "./helpers/email-capture.js";

describe("Email — password reset flow (integration)", () => {
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

  it("emails a reset link that lets the user pick a new password", async () => {
    const email = "carol@example.com";
    const oldPassword = "old-password-12345";
    const newPassword = "new-password-67890";
    await signUpAndSignIn(handle, { email, password: oldPassword, name: "Carol" });

    // Request the reset email.
    const req = await handle.app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      payload: { email, redirectTo: "http://localhost:3001/reset-password" },
      headers: { "content-type": "application/json" },
    });
    expect(req.statusCode).toBe(200);

    const msg = handle.capture.last(email);
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/reset/i);

    // BetterAuth ships the reset URL as
    // `${baseURL}/reset-password/<token>?callbackURL=<redirectTo>`. The token
    // is a path segment, not a query parameter.
    const resetUrl = extractUrl(msg!.html, (u) =>
      u.includes("/api/auth/reset-password/"),
    );
    const pathname = new URL(resetUrl).pathname;
    const token = pathname.split("/api/auth/reset-password/")[1];
    expect(token).toBeTruthy();

    // Apply the new password.
    const apply = await handle.app.inject({
      method: "POST",
      url: `/api/auth/reset-password?token=${encodeURIComponent(token!)}`,
      payload: { newPassword },
      headers: { "content-type": "application/json" },
    });
    expect(apply.statusCode).toBe(200);

    // Sign in with the new password.
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password: newPassword },
      headers: { "content-type": "application/json" },
    });
    expect(signIn.statusCode).toBe(200);
  });
});
