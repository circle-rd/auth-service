/**
 * Integration test — magic-link sign-in flow.
 *
 * 1. POST /api/auth/sign-in/magic-link with an email — magic-link email sent.
 * 2. Extract URL from email, GET it → BetterAuth issues a session cookie
 *    and redirects to the callback URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl, toPath } from "./helpers/email-capture.js";

describe("Email — magic-link flow (integration)", () => {
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

  it("emails a magic link that issues a session when followed", async () => {
    const email = "eve@example.com";

    const req = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      payload: { email, callbackURL: "/" },
      headers: { "content-type": "application/json" },
    });
    expect(req.statusCode).toBe(200);

    const msg = handle.capture.last(email);
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/sign.?in|magic/i);

    const link = extractUrl(msg!.html, (u) => u.includes("/api/auth/magic-link/verify"));
    const followed = await handle.app.inject({
      method: "GET",
      url: toPath(link),
    });
    // Magic-link verify redirects to callbackURL on success.
    expect([200, 302]).toContain(followed.statusCode);
    const setCookie = followed.headers["set-cookie"];
    expect(setCookie).toBeDefined();
  });
});
