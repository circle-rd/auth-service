import { auth } from "../../auth.js";
import { ERR } from "../../errors.js";

export interface DeviceSession {
  userId: string;
  email: string;
  expiresAt: Date;
}

/**
 * Validate the BetterAuth session token returned by the device flow. The token
 * is a user session, never a machine credential; the gateway discards it after
 * this call.
 */
export async function validateDeviceSession(
  token: string,
): Promise<DeviceSession> {
  const value = token.trim();
  if (value.length === 0 || value.length > 512) {
    throw ERR.AUTH_001();
  }
  // Go through BetterAuth's adapter so a Redis-backed session store is
  // consulted and an unavailable store fails closed instead of silently
  // approving the token from Postgres.
  let found;
  try {
    const ctx = await auth.$context;
    found = await ctx.internalAdapter.findSession(value);
  } catch {
    throw ERR.AUTH_001();
  }
  if (!found || found.session.expiresAt.getTime() <= Date.now()) {
    throw ERR.AUTH_001();
  }
  return {
    userId: found.user.id,
    email: found.user.email,
    expiresAt: found.session.expiresAt,
  };
}
