import { db } from "../db/index.js";
import { loginHistory } from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";

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
 * Append a successful-login row to `login_history` and refresh the
 * denormalised `user.last_login_at` timestamp. Both writes succeed or fail
 * together; callers in token-issuance hot paths should not block on failures
 * (see hook callers in src/auth.ts which wrap this call in try/catch with a
 * warn-level log).
 */
export async function recordLogin(input: RecordLoginInput): Promise<void> {
  const loggedAt = input.loggedAt ?? new Date();
  await db.insert(loginHistory).values({
    userId: input.userId,
    applicationId: input.applicationId ?? null,
    sessionId: input.sessionId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    loggedAt,
  });
  await db
    .update(userTable)
    .set({ lastLoginAt: loggedAt })
    .where(eq(userTable.id, input.userId));
}
