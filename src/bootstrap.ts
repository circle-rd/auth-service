import { auth } from "./auth.js";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { user as userTable } from "./db/auth-schema.js";
import { eq } from "drizzle-orm";

/**
 * Creates the superadmin user at startup if none exists yet.
 * Reads ADMIN_EMAIL + ADMIN_PASSWORD from environment.
 */
export async function bootstrap(): Promise<void> {
  const { adminEmail, adminPassword } = config.bootstrap;

  if (!adminEmail || !adminPassword) {
    console.warn(
      "[bootstrap] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping superadmin creation.",
    );
    return;
  }

  // Check if any superadmin exists via direct DB query
  try {
    const existing = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.role, "superadmin"))
      .limit(1);

    if (existing.length > 0) {
      console.info("[bootstrap] Superadmin already exists — skipping.");
      return;
    }
  } catch {
    // If query fails (first boot, tables empty), proceed to create
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
    console.info(`[bootstrap] Superadmin created: ${adminEmail}`);
  } catch (err) {
    // User might already exist (email conflict)
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("already") || message.includes("409")) {
      console.info(
        "[bootstrap] Superadmin email already registered — skipping.",
      );
    } else {
      console.error("[bootstrap] Failed to create superadmin:", message);
    }
  }
}
