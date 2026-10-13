import { auth } from "./auth.js";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { oauthClient, user as userTable } from "./db/auth-schema.js";
import { applications } from "./db/schema.js";
import { generateId } from "better-auth";
import { eq, or } from "drizzle-orm";
import { logger } from "./logger.js";
import { publishEvent } from "./services/event-bus.js";
import { replaceClientResource } from "./services/oauth-resources.js";
import { AUTH_SERVICE_SLUG } from "./services/system-apps.js";

// Known default/placeholder bootstrap passwords that must never be accepted in
// production. Matching is exact so a legitimate password that merely contains a
// word like "password" is not rejected.
const WEAK_PASSWORDS = new Set([
  "admin",
  "admin123",
  "admin1234",
  "admin123!",
  "password",
  "password123",
  "password123!",
  "changeme",
  "changeme123",
  "changeme123!",
  "changeme1234",
  "circle",
  "letmein",
]);

const AUTH_SERVICE_APPLICATION_NAME = "Auth Service API";

function authServiceOauthClientValues(app: {
  id: string;
  slug: string;
  name: string;
}) {
  return {
    id: generateId(),
    clientId: app.slug,
    clientSecret: null,
    disabled: true,
    skipConsent: true,
    scopes: ["wallet:self:read"],
    clientCredentialsScopes: [],
    name: app.name,
    uri: config.betterAuth.url,
    redirectUris: [],
    postLogoutRedirectUris: [],
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "web",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    requirePKCE: true,
    metadata: { clientId: app.slug, applicationId: app.id },
  };
}

/**
 * Register auth-service itself as a protected OAuth resource so applications
 * can request JWTs for the user-bound wallet API with `resource=BETTER_AUTH_URL`.
 */
async function ensureAuthServiceApplication(): Promise<boolean> {
  const matches = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      url: applications.url,
      isSystem: applications.isSystem,
    })
    .from(applications)
    .where(
      or(
        eq(applications.slug, AUTH_SERVICE_SLUG),
        eq(applications.url, config.betterAuth.url),
      ),
    );

  const uniqueMatches = new Map(matches.map((row) => [row.id, row]));
  if (uniqueMatches.size > 1) {
    throw new Error(
      `[bootstrap] Multiple applications match the auth-service protected resource (${config.betterAuth.url})`,
    );
  }

  let changed = false;
  let app = [...uniqueMatches.values()][0];
  if (!app) {
    // The admin create flow bootstraps roles, plans and user grants we do not
    // want for an infrastructure-only protected resource.
    const [created] = await db
      .insert(applications)
      .values({
        name: AUTH_SERVICE_APPLICATION_NAME,
        slug: AUTH_SERVICE_SLUG,
        description: "Protected resource for auth-service user APIs",
        isActive: true,
        isSystem: true,
        skipConsent: true,
        allowRegister: false,
        allowedScopes: ["wallet:self:read"],
        redirectUris: [],
        isPublic: false,
        url: config.betterAuth.url,
      })
      .returning({
        id: applications.id,
        slug: applications.slug,
        name: applications.name,
        url: applications.url,
        isSystem: applications.isSystem,
      });
    app = created!;
    changed = true;
    logger.info(
      "[bootstrap] Auth-service protected resource application created",
    );
  } else if (!app.isSystem || app.url !== config.betterAuth.url) {
    await db
      .update(applications)
      .set({
        isSystem: true,
        url: config.betterAuth.url,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, app.id));
    app = { ...app, isSystem: true, url: config.betterAuth.url };
    changed = true;
    logger.info(
      "[bootstrap] Auth-service protected resource application ensured",
    );
  }

  const [client] = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, app.slug))
    .limit(1);
  if (!client) {
    await db.insert(oauthClient).values(authServiceOauthClientValues(app));
    changed = true;
  }

  await replaceClientResource({
    clientId: app.slug,
    identifier: config.betterAuth.url,
    name: app.name,
    allowedResources: [],
  });
  return changed;
}

/**
 * Creates the superadmin user at startup if none exists yet.
 * Reads ADMIN_EMAIL + ADMIN_PASSWORD from environment.
 */
export async function bootstrap(): Promise<void> {
  const authServiceAppChanged = await ensureAuthServiceApplication();
  const { adminEmail, adminPassword } = config.bootstrap;

  if (!adminEmail || !adminPassword) {
    logger.warn(
      "[bootstrap] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping superadmin creation.",
    );
    if (authServiceAppChanged) publishEvent("application.changed");
    return;
  }

  // The seeded account is a full superadmin, so a known default/placeholder
  // password is a direct takeover. Refuse those in production. The minimum
  // length policy is enforced by config.ts (min 8); we only block exact
  // known values here so legitimate passwords are never falsely rejected.
  const normalizedPassword = adminPassword.toLowerCase();
  if (
    config.nodeEnv === "production" &&
    WEAK_PASSWORDS.has(normalizedPassword)
  ) {
    logger.error(
      "[bootstrap] ADMIN_PASSWORD is a known default/placeholder value. " +
        "Set a unique ADMIN_PASSWORD. Superadmin not created.",
    );
    return;
  }

  // Runs after migrations, so the table is guaranteed to exist.
  const existing = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.role, "superadmin"))
    .limit(1);

  if (existing.length > 0) {
    // Keep the bootstrap account usable: an unverified superadmin cannot sign
    // in when email verification is enabled.
    await db
      .update(userTable)
      .set({ emailVerified: true })
      .where(eq(userTable.role, "superadmin"));
    // Emitted for completeness of the vocabulary, not to wake a dashboard:
    // bootstrap runs during startup, before any admin client can be connected,
    // so this announcement is always lost. Announcing the same "the users table
    // changed" signal from here keeps one rule — every write to `user`
    // announces — instead of an exception a reader has to remember.
    publishEvent("user.changed");
    logger.info(
      "[bootstrap] Superadmin already exists — ensured email is verified.",
    );
    if (authServiceAppChanged) publishEvent("application.changed");
    return;
  }

  try {
    await auth.api.createUser({
      body: {
        email: adminEmail,
        password: adminPassword,
        name: "Superadmin",
        role: "superadmin" as "admin",
        // The bootstrap account is trusted: it exists to let an operator in
        // without a mail round-trip, so it starts verified.
        data: { emailVerified: true },
      },
    });
    logger.info({ email: adminEmail }, "[bootstrap] Superadmin created");
  } catch (err) {
    // A pre-existing email is not fatal; anything else is.
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("already") || message.includes("409")) {
      logger.info(
        "[bootstrap] Superadmin email already registered — skipping.",
      );
      return;
    }
    throw err;
  }

  // Belt-and-suspenders: ensure the flag is set even if createUser ignored it.
  await db
    .update(userTable)
    .set({ emailVerified: true })
    .where(eq(userTable.email, adminEmail));

  publishEvent("user.changed");
  if (authServiceAppChanged) publishEvent("application.changed");
}
