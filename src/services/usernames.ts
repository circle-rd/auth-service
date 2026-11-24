import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { resources } from "../db/resource-schema.js";
import { ERR } from "../errors.js";
import { userNamespace } from "./resources/uri.js";

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

/**
 * The username is the namespace of the resources the account owns on the
 * gateway: changing it would orphan them, so it is refused while any exists.
 * Deleting them for good frees the name again.
 */
export async function assertUsernameChangeAllowed(
  userId: string,
  next: string | null | undefined,
): Promise<void> {
  if (next === undefined) return;
  const [current] = await db
    .select({ username: userTable.username })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (
    !current?.username ||
    current.username.toLowerCase() === next?.toLowerCase()
  ) {
    return;
  }
  const prefix = `${userNamespace(current.username)}/`;
  const [owned] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.ownerType, "user"),
        eq(resources.ownerId, userId),
        // starts_with, not LIKE: usernames may hold underscores.
        sql`starts_with(${resources.locator}, ${prefix})`,
      ),
    )
    .limit(1);
  if (owned) throw ERR.RES_018();
}

/** True when a stored username can be emitted verbatim to a resource server. */
export function isPublicUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export interface UserIdentity {
  id: string;
  username: string | null;
  email: string;
}

/** The identifiers a gateway deployment may record as its owner. */
export async function getUserIdentity(
  userId: string,
): Promise<UserIdentity | null> {
  const [row] = await db
    .select({
      id: userTable.id,
      username: userTable.username,
      email: userTable.email,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return row ?? null;
}
