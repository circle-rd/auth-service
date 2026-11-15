import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { session, user } from "../../db/auth-schema.js";
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
  const [row] = await db
    .select({
      userId: session.userId,
      expiresAt: session.expiresAt,
      email: user.email,
    })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(and(eq(session.token, value), gt(session.expiresAt, new Date())))
    .limit(1);
  if (!row) throw ERR.AUTH_001();
  return { userId: row.userId, email: row.email, expiresAt: row.expiresAt };
}
