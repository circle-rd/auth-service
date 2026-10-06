/**
 * Integration test — email verification must not authenticate.
 *
 * Regression coverage for circle-rd/auth-service#52. Clicking the link in a
 * verification email used to create a full session and drop the user in a
 * protected area, which made the link a de-facto bearer credential: anyone who
 * could read the mailbox (a forward, a backup, a shared workstation, a leak)
 * obtained an authenticated session without ever presenting the password or a
 * second factor.
 *
 * Every case here fails on the pre-fix tree, so a green run is evidence the
 * interception is actually in place — not merely that the flow still works.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl, toPath, cookiesFromResponse } from "./helpers/email-capture.js";

/** Email href attributes are HTML-escaped; a browser unescapes before following. */
function unescapeHref(url: string): string {
  return url.replace(/&amp;/g, "&").replace(/&#0?38;/g, "&");
}

/**
 * The `Set-Cookie` entries that actually carry a value. An expiring entry
 * (`Max-Age=0`, empty value) is the revocation mechanism, not a credential, so
 * it is not one of these.
 */
function sessionCookiesWithValue(
  setCookie: string | string[] | undefined,
): string[] {
  if (!setCookie) return [];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.filter((entry) => entry.split(";")[0]?.includes("=") === true &&
    (entry.split(";")[0]?.split("=")[1] ?? "") !== "");
}

async function getSessionWith(
  handle: AuthServerHandle,
  cookie: string,
): Promise<string> {
  const res = await handle.app.inject({
    method: "GET",
    url: "/api/auth/get-session",
    headers: cookie ? { cookie } : {},
  });
  return res.body;
}

describe("Email — verification does not authenticate (integration)", () => {
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

  it("does not issue a session cookie for the sign-up verification click", async () => {
    const email = "nologin@example.com";
    const password = "correct-horse-battery";

    const signUp = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name: "No Login" },
      headers: { "content-type": "application/json" },
    });
    expect(signUp.statusCode).toBe(200);

    const msg = handle.capture.last(email);
    expect(msg).toBeDefined();
    const verifyUrl = unescapeHref(
      extractUrl(msg!.html, (u) => u.includes("/api/auth/verify-email")),
    );

    // The redirect target is the public confirmation page, not `/profile`.
    expect(verifyUrl).toContain("callbackURL=%2Femail-verified");
    expect(verifyUrl).not.toContain("callbackURL=%2Fprofile");

    const verifyRes = await handle.app.inject({
      method: "GET",
      url: toPath(verifyUrl),
    });
    expect([200, 302]).toContain(verifyRes.statusCode);
    // No credential is handed out. An empty expiring entry would just be the
    // revocation mechanism, so the assertion is on cookies that carry a value.
    expect(sessionCookiesWithValue(verifyRes.headers["set-cookie"])).toHaveLength(
      0,
    );

    // No cookie was handed out, and nothing replays as an authenticated session.
    const jar = cookiesFromResponse(
      sessionCookiesWithValue(verifyRes.headers["set-cookie"]),
    );
    expect(jar).toBe("");
    expect(await getSessionWith(handle, jar)).toBe("null");

    // The address really was confirmed — the fix removes the session, not the
    // verification itself.
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
      headers: { "content-type": "application/json" },
    });
    expect(signIn.statusCode).toBe(200);
    expect(sessionCookiesWithValue(signIn.headers["set-cookie"])).not.toHaveLength(
      0,
    );
  });

  it("does not issue a session cookie for the change-of-address second leg", async () => {
    const oldEmail = "legacy@example.com";
    const newEmail = "legacy-new@example.com";
    const password = "good-password-12345";
    const { cookie } = await signUpAndSignIn(handle, {
      email: oldEmail,
      password,
      name: "Legacy",
    });
    expect(cookie).not.toBe("");

    const change = await handle.app.inject({
      method: "POST",
      url: "/api/auth/change-email",
      payload: { newEmail, callbackURL: "/" },
      headers: { "content-type": "application/json", cookie },
    });
    expect(change.statusCode).toBe(200);

    // First hop — confirmation link mailed to the CURRENT address.
    const confirmMsg = handle.capture.last(oldEmail);
    expect(confirmMsg).toBeDefined();
    const confirmUrl = unescapeHref(
      extractUrl(confirmMsg!.html, (u) => u.includes("/api/auth/verify-email")),
    );
    // This hop only asks to confirm the change: it must not report the change
    // as done, and it must not land in a protected area.
    expect(confirmUrl).toContain("status%3Dpending");
    expect(confirmUrl).not.toContain("%2Fprofile");
    const confirmRes = await handle.app.inject({
      method: "GET",
      url: toPath(confirmUrl),
    });
    expect([200, 302]).toContain(confirmRes.statusCode);
    expect(sessionCookiesWithValue(confirmRes.headers["set-cookie"])).toHaveLength(
      0,
    );

    // Second hop — mailed to the NEW address, and here the vendor mints a
    // session unconditionally (it never consults `autoSignInAfterVerification`).
    const verifyMsg = handle.capture.last(newEmail);
    expect(verifyMsg).toBeDefined();
    const verifyUrl = unescapeHref(
      extractUrl(verifyMsg!.html, (u) => u.includes("/api/auth/verify-email")),
    );
    expect(verifyUrl).toContain("status%3Dupdated");
    expect(verifyUrl).not.toContain("%2Fprofile");

    const verifyRes = await handle.app.inject({
      method: "GET",
      url: toPath(verifyUrl),
    });
    expect([200, 302]).toContain(verifyRes.statusCode);
    expect(sessionCookiesWithValue(verifyRes.headers["set-cookie"])).toHaveLength(
      0,
    );

    // Replay only cookies that carry a value; an empty expiring entry is not a
    // credential and must not be presented as one.
    const jar = cookiesFromResponse(sessionCookiesWithValue(verifyRes.headers["set-cookie"]));
    expect(jar).toBe("");
    expect(await getSessionWith(handle, jar)).toBe("null");
  });

  it("keeps a session the caller legitimately holds across a change-of-address click", async () => {
    const oldEmail = "holder@example.com";
    const newEmail = "holder-new@example.com";
    const { cookie } = await signUpAndSignIn(handle, {
      email: oldEmail,
      password: "good-password-12345",
      name: "Holder",
    });

    const change = await handle.app.inject({
      method: "POST",
      url: "/api/auth/change-email",
      payload: { newEmail, callbackURL: "/" },
      headers: { "content-type": "application/json", cookie },
    });
    expect(change.statusCode).toBe(200);

    const confirmUrl = unescapeHref(
      extractUrl(handle.capture.last(oldEmail)!.html, (u) =>
        u.includes("/api/auth/verify-email"),
      ),
    );
    await handle.app.inject({ method: "GET", url: toPath(confirmUrl) });
    const verifyUrl = unescapeHref(
      extractUrl(handle.capture.last(newEmail)!.html, (u) =>
        u.includes("/api/auth/verify-email"),
      ),
    );

    // The user opened the link in the browser session that requested the
    // change. Signing them out there would be a defect of its own, so the
    // interception only revokes a session the endpoint minted for a caller
    // that arrived without one.
    const verifyRes = await handle.app.inject({
      method: "GET",
      url: toPath(verifyUrl),
      headers: { cookie },
    });
    expect([200, 302]).toContain(verifyRes.statusCode);
    expect(await getSessionWith(handle, cookie)).not.toBe("null");
  });
});
