import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  appDelegations,
  appRoles,
  applications,
  userAppRoles,
  userApplications,
} from "../../db/schema.js";
import { member, user as userTable } from "../../db/auth-schema.js";
import { ERR } from "../../errors.js";
import type { ResourceOwnerType, ResourceSubjectType } from "./types.js";
import { ADMIN_ROLES, hasAnyRole } from "../roles.js";

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
  // Grant managers need resource metadata to pick a grant target.
  "resources:read": ["resources:read", "resources:manage", "grants:manage"],
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
  return hasAnyRole(row?.role, ADMIN_ROLES);
}

export async function isApplicationAdmin(
  userId: string,
  applicationId: string,
): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  // An application-admin role is only authoritative while the user still has
  // an active membership: revoking access must also revoke the admin role.
  if (!(await isActiveMember(userId, applicationId))) return false;
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

/** The built-in `guest` role may receive shares but never create resources. */
export const GUEST_ROLE = "guest";

export async function isGuest(
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
        eq(appRoles.name, GUEST_ROLE),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** An active member without the guest role: the only accounts that own resources. */
export async function canOwnResources(
  userId: string,
  applicationId: string,
): Promise<boolean> {
  return (
    (await isActiveMember(userId, applicationId)) &&
    !(await isGuest(userId, applicationId))
  );
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
  if (!(await applicationExistsAndShares(applicationId))) throw ERR.RES_004();
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
    .select({
      enabled: applications.resourceSharingEnabled,
      isActive: applications.isActive,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  return app?.enabled === true && app.isActive === true;
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
  // Owners must still be members; a delegated manager does not need a
  // membership row for the application, only the active delegation.
  if (resource.ownerType === "user" && resource.ownerId === userId) {
    return isActiveMember(userId, resource.applicationId);
  }
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
 * An owner shares a personal resource with existing members one by one, or
 * with an organisation they belong to. Administrators and delegates never grant
 * on a personal resource: they are not its recipients, so they cannot add
 * themselves. An application-owned resource is granted by application admins
 * (any subject) and `grants:manage` delegates (existing members only).
 */
export async function canGrantToSubject(
  userId: string,
  resource: ResourceAuthorityRow,
  subjectType: ResourceSubjectType,
  subjectId: string | null,
): Promise<boolean> {
  if (resource.ownerType === "user") {
    if (resource.ownerId !== userId) return false;
    if (!(await canOwnResources(userId, resource.applicationId))) return false;
    // A member shares a personal resource with individual members, or with an
    // organisation they belong to (recipients still need application
    // membership at access time). An application administrator may open it to
    // any audience within what they belong to themselves.
    // The owner already reaches the resource: granting it to oneself is a no-op.
    if (subjectType === "user" && subjectId === userId) return false;
    if (!(await isApplicationAdmin(userId, resource.applicationId))) {
      if (subjectId === null) return false;
      // The owner consents to expose a personal resource to an application.
      if (subjectType === "application") return true;
      if (subjectType === "user") {
        // Access is gated by the membership of the application the recipient
        // calls through, so a personal resource can name any account.
        return true;
      }
      if (subjectType === "organization") {
        return isOrganizationMember(userId, subjectId);
      }
      return false;
    }
    return audienceWithinReach(
      userId,
      resource.applicationId,
      subjectType,
      subjectId,
    );
  }
  if (await isApplicationAdmin(userId, resource.applicationId)) return true;
  const delegated = await hasDelegatedPermission(
    userId,
    resource.applicationId,
    "grants:manage",
  );
  if (!delegated) return false;
  if (subjectType !== "user" || subjectId === null) return false;
  return isActiveMember(subjectId, resource.applicationId);
}

async function audienceWithinReach(
  userId: string,
  applicationId: string,
  subjectType: ResourceSubjectType,
  subjectId: string | null,
): Promise<boolean> {
  switch (subjectType) {
    case "everyone":
      return subjectId === null;
    case "plan":
    case "application":
      return subjectId !== null;
    case "organization":
      return (
        subjectId !== null && (await isOrganizationMember(userId, subjectId))
      );
    case "user":
      return (
        subjectId !== null && (await isActiveMember(subjectId, applicationId))
      );
    default:
      return false;
  }
}

export async function isOrganizationMember(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    )
    .limit(1);
  return row !== undefined;
}

/** Grant administration is separate from resource administration. */
export async function canManageGrants(
  userId: string,
  resource: ResourceAuthorityRow,
): Promise<boolean> {
  if (resource.ownerType === "user") {
    return (
      resource.ownerId === userId &&
      (await isActiveMember(userId, resource.applicationId))
    );
  }
  if (await isApplicationAdmin(userId, resource.applicationId)) return true;
  return hasDelegatedPermission(
    userId,
    resource.applicationId,
    "grants:manage",
  );
}

export async function assertCanManageGrants(
  userId: string,
  resource: ResourceAuthorityRow,
): Promise<void> {
  if (await canManageGrants(userId, resource)) return;
  throw ERR.RES_002();
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
