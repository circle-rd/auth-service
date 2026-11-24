import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { member, user as userTable } from "../../db/auth-schema.js";
import { userApplications, userSubscriptions } from "../../db/schema.js";

/**
 * What the resource decision needs to know about a person, read from the
 * identity tables. The decision engine reaches identity only through here, so
 * the resources domain can later be served by another component that is given
 * these four facts.
 */

/**
 * A ban blocks token issuance, but tokens already issued stay valid until they
 * expire: the resource decision must not outlive the ban.
 */
export function isBanned(
  row: { banned: boolean | null; banExpires: Date | null },
  now: Date,
): boolean {
  if (row.banned !== true) return false;
  return row.banExpires === null || row.banExpires.getTime() > now.getTime();
}

/** The account exists and is not banned. */
export async function isAccountActive(
  userId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ banned: userTable.banned, banExpires: userTable.banExpires })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return row !== undefined && !isBanned(row, now);
}

/** The applications, among `applicationIds`, the person is an active member of. */
export async function listActiveMemberships(
  userId: string,
  applicationIds: readonly string[],
): Promise<Set<string>> {
  if (applicationIds.length === 0) return new Set();
  const rows = await db
    .select({ applicationId: userApplications.applicationId })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.isActive, true),
        inArray(userApplications.applicationId, [...applicationIds]),
      ),
    );
  return new Set(rows.map((row) => row.applicationId));
}

export async function listOrganizationIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  return rows.flatMap((row) =>
    row.organizationId ? [row.organizationId] : [],
  );
}

/** Plans the person holds in each of `applicationIds`, by application. */
export async function listActivePlanIds(
  userId: string,
  applicationIds: readonly string[],
  now: Date,
): Promise<Map<string, Set<string>>> {
  const byApplication = new Map<string, Set<string>>();
  if (applicationIds.length === 0) return byApplication;
  const rows = await db
    .select({
      applicationId: userSubscriptions.applicationId,
      planId: userSubscriptions.planId,
    })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        inArray(userSubscriptions.applicationId, [...applicationIds]),
        eq(userSubscriptions.isActive, true),
        or(
          isNull(userSubscriptions.expiresAt),
          gt(userSubscriptions.expiresAt, now),
        ),
      ),
    );
  for (const row of rows) {
    const ids = byApplication.get(row.applicationId) ?? new Set<string>();
    ids.add(row.planId);
    byApplication.set(row.applicationId, ids);
  }
  return byApplication;
}
