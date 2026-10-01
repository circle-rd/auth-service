import { auth } from "./auth.js";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { user as userTable } from "./db/auth-schema.js";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

// Common bootstrap passwords that must never be accepted in production.
const WEAK_PASSWORDS = new Set([
  "admin",
  "admin123",
  "admin1234",
  "password",
  "password123",
  "changeme",
  "changeme123",
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

  // The seeded account is a full superadmin, so a guessable password is a
  // direct takeover. Refuse weak/known-default values in production, including
  // anything derived from the shipped `.env.example` placeholder.
  const normalizedPassword = adminPassword.toLowerCase();
  const looksDefault = ["changeme", "password", "letmein", "admin123"].some(
    (token) => normalizedPassword.includes(token),
  );
  if (
    config.nodeEnv === "production" &&
    (adminPassword.length < 12 ||
      looksDefault ||
      WEAK_PASSWORDS.has(normalizedPassword))
  ) {
    logger.error(
      "[bootstrap] ADMIN_PASSWORD is too weak for production " +
        "(minimum 12 characters, not a common default). Superadmin not created.",
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
    logger.info("[bootstrap] Superadmin already exists — skipping.");
    return;
  }

  try {
    await auth.api.createUser({
      body: {
        email: adminEmail,
        password: adminPassword,
        name: "Superadmin",
        role: "superadmin" as "admin",
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
}
