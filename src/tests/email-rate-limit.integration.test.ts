/**
 * Integration test — per-IP rate limit on outbound-email endpoints.
 *
 * The EMAIL_SEND_PATHS bucket in server.ts allows 5 requests per minute per
 * IP. The 6th `request-password-reset` POST from the same client must hit
 * the dedicated bucket and return 429 with the MAIL_003 code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";

describe("Email — rate limit (integration)", () => {
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

  it("returns 429 MAIL_003 on the 6th request-password-reset within the window", async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await handle.app.inject({
        method: "POST",
        url: "/api/auth/request-password-reset",
        payload: { email: `r${i}@example.com`, redirectTo: "http://localhost:3001/reset-password" },
        headers: { "content-type": "application/json" },
      });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await handle.app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      payload: { email: "r6@example.com", redirectTo: "http://localhost:3001/reset-password" },
      headers: { "content-type": "application/json" },
    });
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("MAIL_003");
  });
});
