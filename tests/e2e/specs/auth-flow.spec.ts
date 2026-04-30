/**
 * e2e: authentication flow tests
 *
 * Covers the happy-path scenarios for login, session persistence, logout,
 * new-user registration, and OAuth cross-link URL correctness.
 *
 * Pre-requisites:
 *   docker compose -f tests/e2e/docker-compose.yml up --wait
 *
 * Seeded users (all passwords "TestPass1!"):
 *   alice@test.local  – has explicit access to test-app
 *   bob@test.local    – no access to test-app (auto-provisioned via allowRegister:true)
 *
 * Seeded app:
 *   test-app (allowRegister: true, skipConsent: true, redirectUri: http://localhost:3000/callback)
 */
import { test, expect, type Page } from "@playwright/test";

const AUTH_URL = "http://localhost:3001";
const ALICE = { email: "alice@test.local", password: "TestPass1!" };
const BOB = { email: "bob@test.local", password: "TestPass1!" };

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Navigate to the testapp and kick off the PKCE/OAuth flow. Returns after landing on the auth-service login page. */
async function goToLoginPage(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[data-testid="login-btn"]')).toBeVisible();
  await page.locator('[data-testid="login-btn"]').click();
  // Redirected to auth-service authorize → login page
  await page.waitForURL(`${AUTH_URL}/**`);
  await expect(page.locator("#email")).toBeVisible();
}

/** Fill and submit the auth-service login form. */
async function fillLoginForm(page: Page, email: string, password: string): Promise<void> {
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#submit-btn");
}

/** Perform a full sign-in from the testapp landing to the claims page. */
async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await goToLoginPage(page);
  await fillLoginForm(page, user.email, user.password);
  // Redirected back: testapp callback → testapp root
  await page.waitForURL("http://localhost:3000/");
  await expect(page.locator('[data-testid="claims"]')).toBeVisible();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("Login flow (alice)", () => {
  test("can sign in and see OIDC claims", async ({ page }) => {
    await signIn(page, ALICE);

    const claims = page.locator('[data-testid="claims"]');
    const text = await claims.textContent();
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text!);
    expect(parsed.email).toBe(ALICE.email);
    expect(parsed.sub).toBeTruthy();
  });

  test("session persists after page reload", async ({ page }) => {
    await signIn(page, ALICE);

    await page.reload();
    await expect(page.locator('[data-testid="claims"]')).toBeVisible();

    const text = await page.locator('[data-testid="claims"]').textContent();
    const parsed = JSON.parse(text!);
    expect(parsed.email).toBe(ALICE.email);
  });

  test("logout clears the session", async ({ page }) => {
    await signIn(page, ALICE);

    await page.locator('[data-testid="logout-btn"]').click();
    await page.waitForURL("http://localhost:3000/");

    // After logout, the login button should be visible
    await expect(page.locator('[data-testid="login-btn"]')).toBeVisible();
    const status = await page.locator('[data-testid="status"]').textContent();
    expect(status).toContain("Not signed in");
  });
});

test.describe("Login flow (bob — auto-provisioned via allowRegister)", () => {
  test("bob has no prior access but can sign in to test-app (allowRegister: true)", async ({ page }) => {
    await signIn(page, BOB);

    const text = await page.locator('[data-testid="claims"]').textContent();
    const parsed = JSON.parse(text!);
    expect(parsed.email).toBe(BOB.email);
  });
});

test.describe("Registration flow", () => {
  test("new user can register and complete the OAuth flow back to testapp", async ({ page }) => {
    const timestamp = Date.now();
    const newUser = {
      name: "New User",
      email: `newuser-${timestamp}@test.local`,
      password: "TestPass1!",
    };

    // Start OAuth PKCE flow from testapp
    await goToLoginPage(page);

    // Navigate to the register page via the cross-link
    const registerLink = page.locator("#register-link");
    await expect(registerLink).toBeVisible();
    const registerHref = await registerLink.getAttribute("href");
    // The link should preserve the OAuth query string
    expect(registerHref).toMatch(/client_id=test-app/);

    await registerLink.click();
    await expect(page.locator("#name")).toBeVisible();

    // Fill in registration form
    await page.fill("#name", newUser.name);
    await page.fill("#email", newUser.email);
    await page.fill("#password", newUser.password);
    await page.click("#submit-btn");

    // Redirected back to testapp after successful registration + OAuth flow
    await page.waitForURL("http://localhost:3000/", { timeout: 15_000 });
    await expect(page.locator('[data-testid="claims"]')).toBeVisible();

    const text = await page.locator('[data-testid="claims"]').textContent();
    const parsed = JSON.parse(text!);
    expect(parsed.email).toBe(newUser.email);
    expect(parsed.sub).toBeTruthy();
  });
});

test.describe("Cross-link OAuth param preservation (Bug A regression)", () => {
  test("login page register-link preserves full OAuth query string", async ({ page }) => {
    await goToLoginPage(page);

    // The "Create one" link must carry the same OAuth params
    const registerLink = page.locator("#register-link");
    const href = await registerLink.getAttribute("href");

    expect(href).toBeTruthy();
    // Must include OAuth params from the original PKCE flow
    expect(href).toMatch(/client_id=test-app/);
    expect(href).toMatch(/code_challenge=/);
    expect(href).toMatch(/state=/);
    expect(href).toMatch(/redirect_uri=/);
  });

  test("register page login-link preserves full OAuth query string", async ({ page }) => {
    // Navigate to the register page with OAuth params
    await goToLoginPage(page);
    const registerLink = page.locator("#register-link");
    await registerLink.click();
    await expect(page.locator("#name")).toBeVisible();

    // The "Sign in" link on the register page must carry OAuth params back
    const loginLink = page.locator("#login-link");
    const href = await loginLink.getAttribute("href");

    expect(href).toBeTruthy();
    expect(href).toMatch(/client_id=test-app/);
    expect(href).toMatch(/code_challenge=/);
    expect(href).toMatch(/state=/);
    expect(href).toMatch(/redirect_uri=/);
  });

  test("login page register-link does NOT use the hardcoded /register?redirectTo= pattern when OAuth params are present", async ({ page }) => {
    await goToLoginPage(page);

    const registerLink = page.locator("#register-link");
    const href = await registerLink.getAttribute("href");

    // The old bug: link was always /register?redirectTo={{REDIRECT_TO}} regardless of OAuth context
    expect(href).not.toMatch(/^\\/register\\?redirectTo=/);
  });
});
