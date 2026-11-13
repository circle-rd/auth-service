import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appRoles, userAppRoles, userApplications } from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";

export interface OwnerApplicationMember {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  roles: string[];
}

/**
 * Members of one owner application, with their application roles. The owner
 * application id is supplied by the delegated guard; foreign ids never reach
 * this query. Platform-admin member APIs are deliberately not reused.
 */
export async function listOwnerMembers(
  ownerApplicationId: string,
): Promise<OwnerApplicationMember[]> {
  const rows = await db
    .select({
      userId: userApplications.userId,
      name: userTable.name,
      email: userTable.email,
      isActive: userApplications.isActive,
      role: appRoles.name,
    })
    .from(userApplications)
    .innerJoin(userTable, eq(userTable.id, userApplications.userId))
    .leftJoin(
      userAppRoles,
      and(
        eq(userAppRoles.userId, userApplications.userId),
        eq(userAppRoles.applicationId, userApplications.applicationId),
      ),
    )
    .leftJoin(appRoles, eq(userAppRoles.roleId, appRoles.id))
    .where(eq(userApplications.applicationId, ownerApplicationId))
    .orderBy(asc(userTable.name), asc(userTable.email));

  const byUser = new Map<string, OwnerApplicationMember>();
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (existing) {
      if (row.role && !existing.roles.includes(row.role)) {
        existing.roles.push(row.role);
      }
      continue;
    }
    byUser.set(row.userId, {
      userId: row.userId,
      name: row.name,
      email: row.email,
      isActive: row.isActive,
      roles: row.role ? [row.role] : [],
    });
  }
  return [...byUser.values()];
}
