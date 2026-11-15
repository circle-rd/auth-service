import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  appDelegations,
  appRoles,
  applications,
  userAppRoles,
  userApplications,
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { ERR } from "../../errors.js";
import type { ResourceOwnerType, ResourceSubjectType } from "./types.js";

export const APP_DELEGATION_PERMISSIONS = [
  "resources:read",
  "resources:manage",
  "grants:manage",
] as const;
export type AppDelegationPermission =
  (typeof APP_DELEGATION_PERMISSIONS)[number];

const SATISFIED_BY: Record<
  AppDelegationPermission,
  readonly AppDelegationPermission[]
> = {
  "resources:read": ["resources:read", "resources:manage"],
  "resources:manage": ["resources:manage"],
  "grants:manage": ["grants:manage"],
};

export interface ResourceAuthorityRow {
  applicationId: string;
  ownerType: ResourceOwnerType;
  ownerId: string;
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return row?.role === "admin" || row?.role === "superadmin";
}

export async function isApplicationAdmin(
  userId: string,
  applicationId: string,
): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
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

export async function assertActiveMember(
  userId: string,
  applicationId: string,
): Promise<void> {
  if (await isActiveMember(userId, applicationId)) return;
  throw ERR.RES_004();
}

export async function isActiveMember(
  userId: string,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: userApplications.id })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, applicationId),
        eq(userApplications.isActive, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function applicationExistsAndShares(
  applicationId: string,
): Promise<boolean> {
  const [app] = await db
    .select({ enabled: applications.resourceSharingEnabled })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  return app?.enabled === true;
}

/** Application admins and platform admins only; unknown apps share the 404. */
export async function assertAppAdmin(
  userId: string,
  applicationId: string,
): Promise<void> {
  if (!(await applicationExistsAndShares(applicationId))) {
    throw ERR.RES_004();
  }
  if (await isApplicationAdmin(userId, applicationId)) return;
  throw ERR.RES_004();
}

/** Least-privilege owner guard shared by resource, grant and usage routes. */
export async function assertAppPermission(
  userId: string,
  applicationId: string,
  permission: AppDelegationPermission,
): Promise<void> {
  if (!(await applicationExistsAndShares(applicationId))) {
    throw ERR.RES_004();
  }
  if (await isApplicationAdmin(userId, applicationId)) return;
  if (await hasDelegatedPermission(userId, applicationId, permission)) return;
  throw ERR.RES_004();
}

export async function canManageResource(
  userId: string,
  resource: ResourceAuthorityRow,
): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  if (!(await isActiveMember(userId, resource.applicationId))) return false;
  if (resource.ownerType === "user" && resource.ownerId === userId) return true;
  if (await isApplicationAdmin(userId, resource.applicationId)) return true;
  return hasDelegatedPermission(
    userId,
    resource.applicationId,
    "resources:manage",
  );
}

export async function assertCanManageResource(
  userId: string,
  resource: ResourceAuthorityRow,
): Promise<void> {
  if (await canManageResource(userId, resource)) return;
  throw ERR.RES_002();
}

/**
 * A standard owner or `grants:manage` delegate may only share with an existing
 * member of the resource application. Organisations, plans, everyone and
 * non-members require an application admin, who can add the recipient.
 */
export async function canGrantToSubject(
  userId: string,
  resource: ResourceAuthorityRow,
  subjectType: ResourceSubjectType,
  subjectId: string | null,
): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  if (!(await isActiveMember(userId, resource.applicationId))) return false;
  if (await isApplicationAdmin(userId, resource.applicationId)) return true;

  const isOwner = resource.ownerType === "user" && resource.ownerId === userId;
  const delegated = await hasDelegatedPermission(
    userId,
    resource.applicationId,
    "grants:manage",
  );
  if (!isOwner && !delegated) return false;
  if (subjectType !== "user" || subjectId === null) return false;
  return isActiveMember(subjectId, resource.applicationId);
}

export async function assertCanGrantToSubject(
  userId: string,
  resource: ResourceAuthorityRow,
  subjectType: ResourceSubjectType,
  subjectId: string | null,
): Promise<void> {
  if (await canGrantToSubject(userId, resource, subjectType, subjectId)) return;
  throw ERR.RES_004();
}
