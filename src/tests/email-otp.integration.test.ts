/**
 * Integration test — email OTP sign-in flow.
 *
 * 1. POST /api/auth/email-otp/send-verification-otp with `type: "sign-in"`.
 * 2. Extract 6-digit OTP from the captured email.
 * 3. POST /api/auth/sign-in/email-otp with email + OTP — session issued.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractOtp } from "./helpers/email-capture.js";

describe("Email — OTP flow (integration)", () => {
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

  it("emails a 6-digit OTP that can be exchanged for a session", async () => {
    const email = "fred@example.com";

    const sendRes = await handle.app.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      payload: { email, type: "sign-in" },
      headers: { "content-type": "application/json" },
    });
    expect(sendRes.statusCode).toBe(200);

    const msg = handle.capture.last(email);
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/code|otp|verification/i);

    const otp = extractOtp(msg!.html);
    expect(otp).toMatch(/^\d{6}$/);

    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email-otp",
      payload: { email, otp },
      headers: { "content-type": "application/json" },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.headers["set-cookie"]).toBeDefined();
  });
});
