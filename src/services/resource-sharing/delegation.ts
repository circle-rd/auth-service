import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appDelegations, appRoles, userAppRoles } from "../../db/schema.js";
import { ERR } from "../../errors.js";

export const APP_DELEGATION_PERMISSIONS = [
  "resources:read",
  "resources:manage",
  "grants:manage",
] as const;
export type AppDelegationPermission =
  (typeof APP_DELEGATION_PERMISSIONS)[number];

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
