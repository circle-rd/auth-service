/**
 * Integration test DB helpers.
 *
 * `cleanDb()` truncates all application + auth tables between tests so each
 * test starts from a clean state without restarting the container.
 *
 * Tables are truncated in an order that respects FK constraints (children
 * before parents, or via CASCADE).
 */
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";

/**
 * Truncate all tables in the correct dependency order.
 * The RESTART IDENTITY CASCADE ensures sequences reset and FKs are handled.
 */
export async function cleanDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE
      app_role_permissions,
      user_app_roles,
      app_permissions,
      app_roles,
      user_subscriptions,
      subscription_plan_prices,
      subscription_plans,
      consumption_aggregates,
      consumption_entries,
      user_applications,
      applications,
      two_factor,
      passkey,
      oauth_client,
      "session",
      account,
      verification,
      "user"
    RESTART IDENTITY CASCADE`,
  );
}
