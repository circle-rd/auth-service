import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  appDelegations,
  appRoles,
  applications,
  userAppRoles,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";

export const APP_DELEGATION_PERMISSIONS = [
  "resources:read",
  "resources:manage",
  "grants:manage",
] as const;
export type AppDelegationPermission =
  (typeof APP_DELEGATION_PERMISSIONS)[number];

export function isAppDelegationPermission(
  value: string,
): value is AppDelegationPermission {
  return (APP_DELEGATION_PERMISSIONS as readonly string[]).includes(value);
}

export type AppDelegation = typeof appDelegations.$inferSelect;

/** Permissions a delegation row may satisfy, including the managing superset. */
const SATISFIED_BY: Record<
  AppDelegationPermission,
  readonly AppDelegationPermission[]
> = {
  "resources:read": ["resources:read", "resources:manage"],
  "resources:manage": ["resources:manage"],
  "grants:manage": ["grants:manage"],
};

/**
 * An application's built-in `admin` role is its original owner representation:
 * application creation grants it to the creator and every superadmin. Holding
 * it implies every owner permission; no platform role is consulted here.
 */
export async function isApplicationOwner(
  userId: string,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ roleId: appRoles.id })
    .from(userAppRoles)
    .innerJoin(
      appRoles,
      and(
        eq(userAppRoles.roleId, appRoles.id),
        eq(appRoles.applicationId, applicationId),
      ),
    )
    .where(
      and(
        eq(userAppRoles.userId, userId),
        eq(userAppRoles.applicationId, applicationId),
        eq(appRoles.name, "admin"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function hasDelegatedPermission(
  userId: string,
  applicationId: string,
  permission: AppDelegationPermission,
): Promise<boolean> {
  const [row] = await db
    .select({ id: appDelegations.id })
    .from(appDelegations)
    .where(
      and(
        eq(appDelegations.userId, userId),
        eq(appDelegations.applicationId, applicationId),
        eq(appDelegations.status, "active"),
        inArray(appDelegations.permission, SATISFIED_BY[permission]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Authorise an owner mutation. Missing applications, foreign applications and
 * insufficient permissions all fail with the same 404 so ownership cannot be
 * enumerated. The caller is a verified session user id, never request input.
 */
export async function assertAppDelegation(
  userId: string,
  applicationId: string,
  permission: AppDelegationPermission,
): Promise<void> {
  if (await isApplicationOwner(userId, applicationId)) return;
  if (await hasDelegatedPermission(userId, applicationId, permission)) return;
  throw ERR.RES_004();
}

export interface OwnerApplicationSummary {
  id: string;
  name: string;
  slug: string;
  url: string | null;
  icon: string | null;
  permissions: AppDelegationPermission[];
}

/**
 * Applications the session user may administer, with the least-privilege
 * permissions they hold. Built-in app admins hold every owner permission;
 * delegated users hold exactly their active rows. This is the owner-side
 * discovery surface the portal needs, so no platform-admin route is involved.
 */
export async function listOwnerApplications(
  userId: string,
): Promise<OwnerApplicationSummary[]> {
  const adminRows = await db
    .selectDistinct({
      id: applications.id,
      name: applications.name,
      slug: applications.slug,
      url: applications.url,
      icon: applications.icon,
    })
    .from(userAppRoles)
    .innerJoin(appRoles, eq(userAppRoles.roleId, appRoles.id))
    .innerJoin(applications, eq(appRoles.applicationId, applications.id))
    .where(
      and(
        eq(userAppRoles.userId, userId),
        eq(applications.isActive, true),
        eq(appRoles.name, "admin"),
      ),
    )
    .orderBy(asc(applications.name));

  const delegatedRows = await db
    .selectDistinct({
      id: applications.id,
      name: applications.name,
      slug: applications.slug,
      url: applications.url,
      icon: applications.icon,
      permission: appDelegations.permission,
    })
    .from(appDelegations)
    .innerJoin(applications, eq(appDelegations.applicationId, applications.id))
    .where(
      and(
        eq(appDelegations.userId, userId),
        eq(appDelegations.status, "active"),
        eq(applications.isActive, true),
        inArray(appDelegations.permission, APP_DELEGATION_PERMISSIONS),
      ),
    );

  const byId = new Map<string, OwnerApplicationSummary>();
  for (const row of adminRows) {
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      url: row.url,
      icon: row.icon,
      permissions: [...APP_DELEGATION_PERMISSIONS],
    });
  }
  for (const row of delegatedRows) {
    if (!isAppDelegationPermission(row.permission)) continue;
    const existing = byId.get(row.id);
    if (existing) {
      if (!existing.permissions.includes(row.permission)) {
        existing.permissions.push(row.permission);
      }
      continue;
    }
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      url: row.url,
      icon: row.icon,
      permissions: [row.permission],
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
