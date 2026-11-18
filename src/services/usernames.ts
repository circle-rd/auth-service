import { and, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";

/**
 * Public identifier accepted as an OAuth `preferred_username`. Resource servers
 * that key accounts by this claim (the reverse relay maps it to an agent
 * namespace) accept the same narrow alphabet as a client id.
 */
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/**
 * Reject a username already held by another account. Uniqueness is global and
 * case-insensitive; the database index is the concurrency backstop.
 */
export async function assertUsernameAvailable(
  username: string,
  excludeUserId?: string,
): Promise<void> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(
      and(
        sql`lower(${userTable.username}) = lower(${username})`,
        excludeUserId ? ne(userTable.id, excludeUserId) : undefined,
      ),
    )
    .limit(1);
  if (row) throw new Error("USERNAME_TAKEN");
}

/** True when a stored username can be emitted verbatim to a resource server. */
export function isPublicUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}
