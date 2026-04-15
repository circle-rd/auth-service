/**
 * e2e seed script — provisions all test fixtures against a running auth-service.
 *
 * Creates:
 *   Applications:
 *     - test-app        (allowRegister: true,  isPublic: false) — happy-path app
 *     - restricted-app  (allowRegister: false, isPublic: false) — explicit access only
 *     - public-app      (allowRegister: false, isPublic: true)  — open to all users
 *
 *   Users (password: "TestPass1!" for all):
 *     - alice@test.local  → has explicit access to test-app + restricted-app
 *     - bob@test.local    → no access to any app
 *     - charlie@test.local → access to test-app revoked (isActive: false)
 *
 * Credentials are written to /shared/credentials.json for the testapp service.
 * Application IDs are written to /shared/fixtures.json for use in Playwright tests.
 */
import fs from "fs";

const AUTH_INTERNAL = (process.env["AUTH_SERVICE_INTERNAL_URL"] ?? "http://auth-service:3001").replace(/\/$/, "");
const ADMIN_EMAIL = process.env["ADMIN_EMAIL"] ?? "admin@test.local";
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] ?? "AdminPass1!";
const APP_SLUG = process.env["APP_SLUG"] ?? "test-app";
const REDIRECT_URI = process.env["REDIRECT_URI"] ?? "http://testapp:3000/callback";
const CREDENTIALS_PATH = process.env["CREDENTIALS_PATH"] ?? "/shared/credentials.json";
const FIXTURES_PATH = process.env["FIXTURES_PATH"] ?? "/shared/fixtures.json";
const TEST_PASSWORD = "TestPass1!";

const APP_ORIGIN = new URL(REDIRECT_URI).origin;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await fetch(`${AUTH_INTERNAL}/health`);
      if (res.ok) {
        console.log("auth-service is ready.");
        return;
      }
    } catch {
      // not yet available
    }
    console.log(`Waiting for auth-service… (${attempt}/30)`);
    await delay(3000);
  }
  throw new Error("auth-service did not become available within 90 seconds.");
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${AUTH_INTERNAL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sign-in failed (${res.status}): ${body}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie received after sign-in.");
  return setCookie
    .split(/,(?=[^ ])/)
    .map((c) => c.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

type Headers = Record<string, string>;

interface AppResult {
  id: string;
  clientId: string;
  clientSecret: string | null;
}

async function upsertApp(
  headers: Headers,
  name: string,
  slug: string,
  opts: { allowRegister?: boolean; isPublic?: boolean } = {},
): Promise<AppResult> {
  const body = {
    name,
    slug,
    redirectUris: [REDIRECT_URI],
    allowedScopes: ["openid", "profile", "email", "roles"],
    skipConsent: true,
    allowRegister: opts.allowRegister ?? true,
    isPublic: opts.isPublic ?? false,
  };

  const createRes = await fetch(`${AUTH_INTERNAL}/api/admin/applications`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (createRes.status === 201) {
    const data = (await createRes.json()) as { application: { id: string }; clientId: string; clientSecret?: string };
    console.log(`  Created app: ${slug}`);
    return { id: data.application.id, clientId: data.clientId, clientSecret: data.clientSecret ?? null };
  }

  if (createRes.status === 409) {
    // Already exists — list to find the ID
    const listRes = await fetch(`${AUTH_INTERNAL}/api/admin/applications`, { headers });
    const { applications } = (await listRes.json()) as { applications: Array<{ id: string; slug: string }> };
    const existing = applications.find((a) => a.slug === slug);
    if (!existing) throw new Error(`Cannot find existing app: ${slug}`);

    // Public apps have no client secret — skip rotation
    if (opts.isPublic) {
      console.log(`  Reused app: ${slug} (public, no secret)`);
      return { id: existing.id, clientId: slug, clientSecret: null };
    }

    const rotRes = await fetch(`${AUTH_INTERNAL}/api/admin/applications/${existing.id}/rotate-secret`, {
      method: "POST",
      headers,
    });
    if (!rotRes.ok) throw new Error(`Secret rotation failed for ${slug}: ${rotRes.status}`);
    const { clientSecret } = (await rotRes.json()) as { clientSecret: string };
    console.log(`  Reused app: ${slug} (secret rotated)`);
    return { id: existing.id, clientId: slug, clientSecret };
  }

  throw new Error(`Unexpected response creating app ${slug}: ${createRes.status}`);
}

interface UserResult { id: string }

async function upsertUser(headers: Headers, name: string, email: string): Promise<UserResult> {
  const createRes = await fetch(`${AUTH_INTERNAL}/api/admin/users`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: TEST_PASSWORD, role: "user" }),
  });

  if (createRes.status === 201 || createRes.status === 200) {
    const data = (await createRes.json()) as { user: { id: string } };
    console.log(`  Created user: ${email}`);
    return { id: data.user.id };
  }

  if (createRes.status === 409 || createRes.status === 422) {
    // Already exists — list users to find the ID
    const listRes = await fetch(`${AUTH_INTERNAL}/api/admin/users?limit=100`, { headers });
    const { users } = (await listRes.json()) as { users: Array<{ id: string; email: string }> };
    const existing = users.find((u) => u.email === email);
    if (!existing) throw new Error(`Cannot find existing user: ${email}`);
    console.log(`  Reused user: ${email}`);
    return { id: existing.id };
  }

  throw new Error(`Unexpected response creating user ${email}: ${createRes.status}`);
}

async function grantAccess(headers: Headers, userId: string, appId: string, isActive = true): Promise<void> {
  // Step 1: grant access (always creates with isActive=true)
  const res = await fetch(`${AUTH_INTERNAL}/api/admin/applications/${appId}/users`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  // 201 = created, 409 = already exists (idempotent)
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to grant access: ${res.status}`);
  }

  // Step 2: if we want isActive=false, patch it after creation
  if (!isActive) {
    const patchRes = await fetch(`${AUTH_INTERNAL}/api/admin/applications/${appId}/users/${userId}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    if (!patchRes.ok) {
      throw new Error(`Failed to revoke access: ${patchRes.status}`);
    }
  }
}

async function main(): Promise<void> {
  await waitForHealth();

  console.log("Signing in as admin…");
  const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const authHeaders: Headers = { Cookie: cookie, Origin: APP_ORIGIN };

  console.log("Provisioning applications…");
  const testApp = await upsertApp(authHeaders, "Test App", APP_SLUG, { allowRegister: true, isPublic: false });
  const restrictedApp = await upsertApp(authHeaders, "Restricted App", "restricted-app", { allowRegister: false, isPublic: false });
  const publicApp = await upsertApp(authHeaders, "Public App", "public-app", { allowRegister: false, isPublic: true });

  console.log("Provisioning users…");
  const alice = await upsertUser(authHeaders, "Alice Test", "alice@test.local");
  const bob = await upsertUser(authHeaders, "Bob Test", "bob@test.local");
  const charlie = await upsertUser(authHeaders, "Charlie Test", "charlie@test.local");

  console.log("Granting access…");
  // Alice has active access to test-app and restricted-app
  await grantAccess(authHeaders, alice.id, testApp.id, true);
  await grantAccess(authHeaders, alice.id, restrictedApp.id, true);
  // Bob has no access to anything
  // Charlie had access to test-app but it was revoked
  await grantAccess(authHeaders, charlie.id, testApp.id, false);

  // Write credentials for testapp container
  fs.mkdirSync("/shared", { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ clientId: testApp.clientId, clientSecret: testApp.clientSecret }, null, 2));

  // Write fixture metadata for Playwright tests
  fs.writeFileSync(
    FIXTURES_PATH,
    JSON.stringify(
      {
        apps: {
          testApp: { id: testApp.id, slug: APP_SLUG, clientId: testApp.clientId },
          restrictedApp: { id: restrictedApp.id, slug: "restricted-app", clientId: restrictedApp.clientId },
          publicApp: { id: publicApp.id, slug: "public-app", clientId: publicApp.clientId },
        },
        users: {
          alice: { id: alice.id, email: "alice@test.local", password: TEST_PASSWORD },
          bob: { id: bob.id, email: "bob@test.local", password: TEST_PASSWORD },
          charlie: { id: charlie.id, email: "charlie@test.local", password: TEST_PASSWORD },
        },
      },
      null,
      2,
    ),
  );

  console.log("Seed complete. Credentials written to", CREDENTIALS_PATH);
  console.log("Fixture metadata written to", FIXTURES_PATH);
}

main().catch((err: unknown) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
