/**
 * e2e: access-control tests
 *
 * Covers the OIDC token-claim guard (customIdTokenClaims) logic:
 *   1. isPublic: true  → any authenticated user can obtain tokens (auto-provisioned)
 *   2. allowRegister: true → same (auto-provisioned on first token exchange)
 *   3. allowRegister: false, isPublic: false, no userApplications row → FORBIDDEN
 *   4. isActive: false (revoked) → FORBIDDEN
 *
 * These tests drive the full OAuth authorization-code flow via the browser so that
 * the customIdTokenClaims hook fires on the server during token exchange.
 *
 * The testapp (test-app) is used as the baseline "happy path" app.
 * For other apps we start a manual PKCE flow navigating directly to the auth-service
 * authorize endpoint; the redirect_uri still points to testapp's /callback handler so
 * the testapp server exchanges the code for us.
 *
 * Pre-requisites:
 *   docker compose -f tests/e2e/docker-compose.yml up --wait
 */
import { test, expect, type Page } from "@playwright/test";
import crypto from "crypto";

const AUTH_URL = "http://localhost:3001";
const TESTAPP_URL = "http://localhost:3000";
const REDIRECT_URI = `${TESTAPP_URL}/callback`;

const ALICE = { email: "alice@test.local", password: "TestPass1!" };
const BOB = { email: "bob@test.local", password: "TestPass1!" };
const CHARLIE = { email: "charlie@test.local", password: "TestPass1!" };

// ── PKCE helpers (run in Node context, not browser) ───────────────────────────

function randomBase64url(n: number): string {
  return crypto.randomBytes(n).toString("base64url");
}

async function sha256base64url(plain: string): Promise<string> {
  const hash = crypto.createHash("sha256").update(plain).digest();
  return hash.toString("base64url");
}

// ── Navigation helper ─────────────────────────────────────────────────────────

interface PkceSession {
  verifier: string;
  state: string;
  challenge: string;
}

async function buildPkce(): Promise<PkceSession> {
  const verifier = randomBase64url(48);
  const challenge = await sha256base64url(verifier);
  const state = randomBase64url(16);
  return { verifier, state, challenge };
}

/**
 * Navigate to the given app's authorize endpoint, triggering a full PKCE flow.
 * Returns after landing on the auth-service login page (or an error page on FORBIDDEN).
 */
async function goToAuthorizePage(page: Page, appSlug: string, pkce: PkceSession): Promise<void> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: appSlug,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email roles",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
  });
  await page.goto(`${AUTH_URL}/api/auth/oauth2/authorize?${params}`);
  // Should redirect to login page
  await page.waitForURL(`${AUTH_URL}/**`);
}

/** Fill and submit the auth-service login form. */
async function fillLoginForm(page: Page, email: string, password: string): Promise<void> {
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#submit-btn");
}

/**
 * Store the PKCE verifier + state in sessionStorage so the testapp's callback
 * handler can complete the code exchange.  This mirrors what the testapp's own
 * "startLogin" JS does.  We inject it BEFORE starting the OAuth flow so the
 * values are present when the callback page loads.
 *
 * NOTE: sessionStorage is origin-scoped, so we need to navigate to testapp first.
 */
async function injectPkceIntoTestappSession(page: Page, pkce: PkceSession): Promise<void> {
  await page.goto(TESTAPP_URL);
  await page.evaluate(
    ({ verifier, state }) => {
      sessionStorage.setItem("pkce_verifier", verifier);
      sessionStorage.setItem("pkce_state", state);
    },
    { verifier: pkce.verifier, state: pkce.state },
  );
}

/**
 * Performs a full OAuth flow for the given app and user.
 * After success, lands on `http://localhost:3000/` with claims visible.
 * Returns the parsed claims object or null if FORBIDDEN.
 */
async function performOAuthFlow(
  page: Page,
  appSlug: string,
  user: { email: string; password: string },
): Promise<Record<string, unknown> | null> {
  const pkce = await buildPkce();
  // Store PKCE values in testapp's sessionStorage so callback can exchange the code
  await injectPkceIntoTestappSession(page, pkce);

  // Start the OAuth authorize flow
  await goToAuthorizePage(page, appSlug, pkce);
  await expect(page.locator("#email")).toBeVisible({ timeout: 8_000 });

  // Fill and submit login form
  await fillLoginForm(page, user.email, user.password);

  // Could land on testapp callback (success) OR an error page (forbidden)
  const landingUrl = await page.waitForURL(
    (url) => url.href.startsWith(TESTAPP_URL) || url.href.includes("error"),
    { timeout: 12_000 },
  );

  if (page.url().includes("error") || page.url().startsWith(`${AUTH_URL}`)) {
    // Stayed on auth-service — likely FORBIDDEN or consent denial
    return null;
  }

  // Wait for testapp to finish code exchange and display claims
  await page.waitForURL(`${TESTAPP_URL}/`, { timeout: 12_000 });
  const claimsEl = page.locator('[data-testid="claims"]');
  await expect(claimsEl).toBeVisible({ timeout: 8_000 });
  const text = await claimsEl.textContent();
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("isPublic app (public-app)", () => {
  test("alice can obtain tokens for a public app even without an explicit userApplications row", async ({ page }) => {
    const claims = await performOAuthFlow(page, "public-app", ALICE);
    expect(claims).not.toBeNull();
    expect(claims?.email).toBe(ALICE.email);
  });

  test("bob can also obtain tokens for a public app (auto-provisioned)", async ({ page }) => {
    const claims = await performOAuthFlow(page, "public-app", BOB);
    expect(claims).not.toBeNull();
    expect(claims?.email).toBe(BOB.email);
  });
});

test.describe("allowRegister app (test-app)", () => {
  test("bob has no explicit access row but allowRegister:true auto-provisions on first sign-in", async ({ page }) => {
    const claims = await performOAuthFlow(page, "test-app", BOB);
    expect(claims).not.toBeNull();
    expect(claims?.email).toBe(BOB.email);
  });
});

test.describe("restricted app (restricted-app — allowRegister: false, isPublic: false)", () => {
  test("alice (explicit access) can obtain tokens", async ({ page }) => {
    const claims = await performOAuthFlow(page, "restricted-app", ALICE);
    expect(claims).not.toBeNull();
    expect(claims?.email).toBe(ALICE.email);
  });

  test("bob (no access) is denied (FORBIDDEN)", async ({ page }) => {
    const pkce = await buildPkce();
    await injectPkceIntoTestappSession(page, pkce);
    await goToAuthorizePage(page, "restricted-app", pkce);
    await expect(page.locator("#email")).toBeVisible({ timeout: 8_000 });

    await fillLoginForm(page, BOB.email, BOB.password);

    // Should NOT be redirected to testapp with a valid code.
    // The auth-service should show an error or redirect with error=access_denied.
    // Wait generously for the navigation to settle.
    await page.waitForTimeout(3_000);

    const currentUrl = page.url();
    const isOnTestapp = currentUrl.startsWith(TESTAPP_URL);

    if (isOnTestapp) {
      // If we ended up on testapp, claims should not be visible (error shown instead)
      const claimsEl = page.locator('[data-testid="claims"]');
      const claimsVisible = await claimsEl.isVisible().catch(() => false);
      if (claimsVisible) {
        const text = await claimsEl.textContent();
        // If claims ARE visible, it means access was unexpectedly granted — fail.
        throw new Error(`Bob should not have access to restricted-app but got claims: ${text}`);
      }
      // Error displayed on testapp — acceptable
    }
    // If still on auth-service  — also acceptable (FORBIDDEN before redirect)
  });

  test("charlie (revoked access, isActive: false) is denied (FORBIDDEN)", async ({ page }) => {
    const pkce = await buildPkce();
    await injectPkceIntoTestappSession(page, pkce);
    await goToAuthorizePage(page, "test-app", pkce);
    await expect(page.locator("#email")).toBeVisible({ timeout: 8_000 });

    await fillLoginForm(page, CHARLIE.email, CHARLIE.password);

    // Charlie's isActive is false — expect FORBIDDEN
    await page.waitForTimeout(3_000);

    const currentUrl = page.url();
    if (currentUrl.startsWith(TESTAPP_URL)) {
      const claimsEl = page.locator('[data-testid="claims"]');
      const claimsVisible = await claimsEl.isVisible().catch(() => false);
      if (claimsVisible) {
        const text = await claimsEl.textContent();
        throw new Error(`Charlie has revoked access but got claims: ${text}`);
      }
    }
    // FORBIDDEN response → no valid claims — test passes
  });
});
