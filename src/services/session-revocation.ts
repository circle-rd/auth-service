import { auth } from "../auth.js";
import {
  deleteUserAccessTokens,
  revokeUserRefreshTokens,
} from "./oauth-tokens.js";

/**
 * Revoke every session and OAuth token a user holds.
 *
 * Order matters. The refresh tokens are the long-lived credential, so they are
 * revoked first (one atomic UPDATE; rows stay in place for the OAuth provider's
 * back-channel logout plan). The session rows are then deleted through
 * BetterAuth's internal adapter, which runs its delete hooks and posts the
 * back-channel logouts. Access tokens are invalid once their session is gone;
 * deleting their rows last is cleanup. A failure at any step leaves the
 * critical refresh credential revoked and a retry is safe.
 */
export async function revokeUserSessionsAndTokens(
  userId: string,
): Promise<void> {
  // First pass stops tokens that already exist. The second pass, after the
  // sessions are gone, catches refresh rows minted in the window between the
  // first update and the session deletion (their `sessionId` is detached by
  // `onDelete: "set null"` and they would otherwise survive).
  await revokeUserRefreshTokens(userId);
  const authCtx = await auth.$context;
  await authCtx.internalAdapter.deleteUserSessions(userId);
  await revokeUserRefreshTokens(userId);
  await deleteUserAccessTokens(userId);
}
