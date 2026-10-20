import { db } from "../db/index.js";
import { loginHistory } from "../db/schema.js";
import {
  user as userTable,
  session as sessionTable,
} from "../db/auth-schema.js";
import { desc, eq } from "drizzle-orm";
import { publishEvent } from "./event-bus.js";

export interface RecordLoginInput {
  userId: string;
  /** Null when the login is a direct admin-dashboard sign-in (no OAuth client). */
  applicationId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Optional explicit timestamp — defaults to now(). Useful in tests. */
  loggedAt?: Date;
}

/**
 * Resolve the client IP / user agent for a login row.
 *
 * The OAuth token-issuance hook (`customAccessTokenClaims`) has no request
 * context, so it records the application login without IP or user agent. The
 * user's most recent session row carries the values captured when they signed
 * in, which is the same client — fall back to it rather than storing nulls.
 */
async function resolveClientContext(
  input: RecordLoginInput,
): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  if (input.ipAddress || input.userAgent) {
    return {
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    };
  }

  const [latest] = await db
    .select({
      ipAddress: sessionTable.ipAddress,
      userAgent: sessionTable.userAgent,
    })
    .from(sessionTable)
    .where(eq(sessionTable.userId, input.userId))
    .orderBy(desc(sessionTable.createdAt))
    .limit(1);

  return {
    ipAddress: latest?.ipAddress ?? null,
    userAgent: latest?.userAgent ?? null,
  };
}

/**
 * Append a successful-login row to `login_history`, refresh the denormalised
 * `user.last_login_at` timestamp, and announce the login on the admin event
 * bus. The two writes succeed or fail together; callers in token-issuance hot
 * paths should not block on failures (see hook callers in src/auth.ts which
 * wrap this call in try/catch with a warn-level log), and the announcement is
 * equally non-fatal — it follows a committed write and never fails it.
 */
export async function recordLogin(input: RecordLoginInput): Promise<void> {
  const loggedAt = input.loggedAt ?? new Date();
  const { ipAddress, userAgent } = await resolveClientContext(input);
  await db.insert(loginHistory).values({
    userId: input.userId,
    applicationId: input.applicationId ?? null,
    sessionId: input.sessionId ?? null,
    ipAddress,
    userAgent,
    loggedAt,
  });
  await db
    .update(userTable)
    .set({ lastLoginAt: loggedAt })
    .where(eq(userTable.id, input.userId));

  // Both login paths (dashboard sign-in through the session hook, OAuth token
  // issuance) funnel through this function, so one announcement covers both.
  // The channel is a signal only: the event carries its type and this instant,
  // never the user id or any other field of the row just written.
  publishEvent("login.recorded");
}
