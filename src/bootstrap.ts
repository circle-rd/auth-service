import { auth } from "./auth.js";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { user as userTable } from "./db/auth-schema.js";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { publishEvent } from "./services/event-bus.js";

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

/**
 * Creates the superadmin user at startup if none exists yet.
 * Reads ADMIN_EMAIL + ADMIN_PASSWORD from environment.
 */
export async function bootstrap(): Promise<void> {
  const { adminEmail, adminPassword } = config.bootstrap;

  if (!adminEmail || !adminPassword) {
    logger.warn(
      "[bootstrap] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping superadmin creation.",
    );
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
}
