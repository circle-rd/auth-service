import { eq } from "drizzle-orm";
import type { User } from "better-auth";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";

/** The adapter operations the snapshot refresh needs. */
interface UserSnapshotAdapter {
  findUserById(userId: string): Promise<User | null>;
  refreshUserSessions(user: User): Promise<void>;
}

type MutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Push the committed user row into every live session mirror without running
 * the `user.update` database hook. With the Redis session store each session
 * carries a copy of its user; writes that bypass BetterAuth's adapter (direct
 * table updates in the admin, profile and MFA code) would otherwise leave
 * role, verification, MFA and profile stale until the next sign-in.
 */
export async function refreshUserSessionSnapshots(
  adapter: UserSnapshotAdapter,
  userId: string,
): Promise<void> {
  const user = await adapter.findUserById(userId);
  if (!user) {
    throw new Error(
      `Cannot refresh session snapshots for missing user ${userId}`,
    );
  }
  await adapter.refreshUserSessions(user);
}

/**
 * Run a user mutation and refresh the session mirrors before the database
 * transaction commits. A Redis failure rolls the mutation back, so a demotion
 * or verification change can never leave the pre-change snapshot usable after
 * Redis recovers.
 */
export async function mutateUserAndRefreshSnapshots<T>(
  adapter: UserSnapshotAdapter,
  userId: string,
  mutate: (tx: MutationTransaction) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    const result = await mutate(tx);
    const [user] = await tx
      .select()
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    if (!user) {
      throw new Error(
        `Cannot refresh session snapshots for missing user ${userId}`,
      );
    }
    await adapter.refreshUserSessions(user);
    return result;
  });
}
