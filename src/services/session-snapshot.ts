import { eq, sql } from "drizzle-orm";
import type { User } from "better-auth";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { ERR } from "../errors.js";
import { logger } from "../logger.js";

/** The adapter operation the snapshot refresh needs. */
interface UserSnapshotAdapter {
  refreshUserSessions(user: User): Promise<void>;
}

/** The Drizzle transaction handed to a snapshot mutation. */
export type SessionSnapshotTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** Test seam: production always runs the real Drizzle transaction. */
export type SessionSnapshotTransactionRunner = <T>(
  fn: (tx: SessionSnapshotTransaction) => Promise<T>,
) => Promise<T>;

const defaultRunner: SessionSnapshotTransactionRunner = (fn) =>
  db.transaction(fn);

// The session mirror is the user object returned by `get-session`. Every column
// is part of that response except the display-only `lastLoginAt`, which is
// deliberately not mirrored (see the resource-sharing plan's known limits).
const snapshotUserColumns = {
  id: userTable.id,
  name: userTable.name,
  email: userTable.email,
  emailVerified: userTable.emailVerified,
  image: userTable.image,
  createdAt: userTable.createdAt,
  updatedAt: userTable.updatedAt,
  twoFactorEnabled: userTable.twoFactorEnabled,
  role: userTable.role,
  banned: userTable.banned,
  banReason: userTable.banReason,
  banExpires: userTable.banExpires,
  isMfaRequired: userTable.isMfaRequired,
  phone: userTable.phone,
  firstName: userTable.firstName,
  lastName: userTable.lastName,
  username: userTable.username,
  company: userTable.company,
  position: userTable.position,
  address: userTable.address,
  postalCode: userTable.postalCode,
  city: userTable.city,
  region: userTable.region,
  country: userTable.country,
  middleName: userTable.middleName,
  profileUrl: userTable.profileUrl,
  website: userTable.website,
  gender: userTable.gender,
  birthdate: userTable.birthdate,
  zoneinfo: userTable.zoneinfo,
  locale: userTable.locale,
} as const;

type SessionUserSnapshot = Omit<typeof userTable.$inferSelect, "lastLoginAt">;

/**
 * The transaction-scoped advisory lock serialises snapshot writers for one
 * user across instances, so a slower writer cannot publish an older row after
 * a newer one. Drizzle has no builder for advisory locks, hence the raw SQL.
 */
async function lockUserSnapshot(
  tx: SessionSnapshotTransaction,
  userId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
}

async function readSessionUser(
  tx: SessionSnapshotTransaction,
  userId: string,
): Promise<SessionUserSnapshot> {
  const [user] = await tx
    .select(snapshotUserColumns)
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!user) throw ERR.USR_001();
  return user;
}

async function publishCommittedSnapshot(
  adapter: UserSnapshotAdapter,
  userId: string,
  run: SessionSnapshotTransactionRunner,
): Promise<void> {
  await run(async (tx) => {
    await lockUserSnapshot(tx, userId);
    await adapter.refreshUserSessions(await readSessionUser(tx, userId));
  });
}

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
  run: SessionSnapshotTransactionRunner = defaultRunner,
): Promise<void> {
  await publishCommittedSnapshot(adapter, userId, run);
}

/**
 * Run a user mutation and publish its session mirror before the database
 * transaction commits. A Redis failure rolls the mutation back, so a demotion
 * can never leave the pre-change snapshot usable after Redis recovers.
 *
 * If the commit itself fails after the mirror was already published, the
 * failed promotion/demotion must not stay cached: the catch reconciles the
 * mirror from the now-committed row (the transaction has rolled back) while
 * holding the same per-user lock. A reconciliation failure is logged and the
 * original error still propagates.
 */
export async function mutateUserAndRefreshSnapshots<T>(
  adapter: UserSnapshotAdapter,
  userId: string,
  mutate: (tx: SessionSnapshotTransaction) => Promise<T>,
  run: SessionSnapshotTransactionRunner = defaultRunner,
): Promise<T> {
  let published = false;
  try {
    return await run(async (tx) => {
      await lockUserSnapshot(tx, userId);
      const result = await mutate(tx);
      await adapter.refreshUserSessions(await readSessionUser(tx, userId));
      published = true;
      return result;
    });
  } catch (err) {
    if (published) {
      try {
        await publishCommittedSnapshot(adapter, userId, run);
      } catch (reconcileErr) {
        logger.error(
          { err: String(reconcileErr), userId },
          "[session-snapshot] failed to reconcile a rolled-back user mutation",
        );
      }
    }
    throw err;
  }
}
