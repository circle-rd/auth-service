/** The one adapter operation the snapshot refresh needs. */
interface UserWriter {
  updateUser(userId: string, data: Record<string, unknown>): Promise<unknown>;
}

/**
 * Push the committed user row into every live session mirror. With the Redis
 * session store each session carries a copy of its user; writes that bypass
 * BetterAuth's adapter (direct table updates in the admin, profile and MFA
 * code) would otherwise leave role, verification, MFA and profile stale until
 * the next sign-in. The adapter's `updateUser` refreshes those copies as a
 * side effect of writing the row, so callers pass the adapter and invoke this
 * only after their own write has committed.
 */
export async function refreshUserSessionSnapshots(
  adapter: UserWriter,
  userId: string,
): Promise<void> {
  await adapter.updateUser(userId, { updatedAt: new Date() });
}
