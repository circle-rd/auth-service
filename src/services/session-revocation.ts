import { auth } from "../auth.js";
import { revokeAllUserTokens } from "./oauth-tokens.js";

/**
 * Revoke every session and OAuth token a user holds. Sessions go through
 * BetterAuth's internal adapter so its delete hooks revoke session-bound tokens
 * and post back-channel logouts; the refresh tokens it deliberately spares are
 * cleared separately.
 */
export async function revokeUserSessionsAndTokens(
  userId: string,
): Promise<void> {
  const authCtx = await auth.$context;
  await authCtx.internalAdapter.deleteUserSessions(userId);
  await revokeAllUserTokens(userId);
}
