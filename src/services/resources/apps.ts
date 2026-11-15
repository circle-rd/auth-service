import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  appDelegations,
  appRoles,
  applications,
  subscriptionPlans,
  userAppRoles,
  userApplications,
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { ERR } from "../../errors.js";
import { assignDefaultRoleIfNeeded } from "../claims.js";
import { publishEvent } from "../event-bus.js";
import { assignDefaultPlanIfNeeded } from "../subscriptions.js";
import { assertAppAdmin } from "./authority.js";
import type { AppDelegationPermission } from "./authority.js";

export const OWNER_PERMISSIONS: readonly AppDelegationPermission[] = [
  "resources:read",
  "resources:manage",
  "grants:manage",
];

export interface OwnerApplicationSummary {
  id: string;
  name: string;
  slug: string;
  url: string | null;
  icon: string | null;
  permissions: AppDelegationPermission[];
  isAdmin: boolean;
}

export interface MemberApplicationSummary {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
}

export async function listMemberApplications(
  userId: string,
): Promise<MemberApplicationSummary[]> {
  return db
    .select({
      id: applications.id,
      name: applications.name,
      slug: applications.slug,
      icon: applications.icon,
    })
    .from(userApplications)
    .innerJoin(
      applications,
      eq(userApplications.applicationId, applications.id),
    )
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.isActive, true),
        eq(applications.isActive, true),
        eq(applications.resourceSharingEnabled, true),
      ),
    )
    .orderBy(asc(applications.name));
}

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
        eq(applications.resourceSharingEnabled, true),
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
        eq(applications.resourceSharingEnabled, true),
        inArray(appDelegations.permission, [...OWNER_PERMISSIONS]),
      ),
    );

  const byId = new Map<string, OwnerApplicationSummary>();
  for (const row of adminRows) {
    byId.set(row.id, {
      ...row,
      permissions: [...OWNER_PERMISSIONS],
      isAdmin: true,
    });
  }
  for (const row of delegatedRows) {
    if (
      !OWNER_PERMISSIONS.includes(row.permission as AppDelegationPermission)
    ) {
      continue;
    }
    const existing = byId.get(row.id);
    if (existing) {
      if (
        !existing.permissions.includes(
          row.permission as AppDelegationPermission,
        )
      ) {
        existing.permissions.push(row.permission as AppDelegationPermission);
      }
      continue;
    }
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      url: row.url,
      icon: row.icon,
      permissions: [row.permission as AppDelegationPermission],
      isAdmin: false,
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface OwnerApplicationMember {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  roles: string[];
}

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

export interface OwnerPlanSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

export async function listOwnerPlans(
  ownerApplicationId: string,
): Promise<OwnerPlanSummary[]> {
  return db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
      isDefault: subscriptionPlans.isDefault,
    })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, ownerApplicationId))
    .orderBy(asc(subscriptionPlans.name));
}

export interface AddedApplicationMember {
  userId: string;
  name: string;
  email: string;
  created: boolean;
  applicationName: string;
  applicationSlug: string;
}

/**
 * Application admins add an existing AuthService account to the resource
 * application. Default role and plan use the same post-commit path as an
 * invitation, so the two membership routes cannot diverge.
 */
export async function addExistingUserToApplication(
  actorUserId: string,
  applicationId: string,
  email: string,
): Promise<AddedApplicationMember> {
  await assertAppAdmin(actorUserId, applicationId);
  const normalized = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: userTable.id, name: userTable.name, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.email, normalized))
    .limit(1);
  if (!user) throw ERR.AUTH_013();
  const [app] = await db
    .select({ name: applications.name, slug: applications.slug })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app) throw ERR.RES_004();

  const [existing] = await db
    .select({ id: userApplications.id, isActive: userApplications.isActive })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, user.id),
        eq(userApplications.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (!existing) {
    await db.insert(userApplications).values({
      userId: user.id,
      applicationId,
      isActive: true,
    });
  } else if (!existing.isActive) {
    await db
      .update(userApplications)
      .set({ isActive: true })
      .where(
        and(
          eq(userApplications.userId, user.id),
          eq(userApplications.applicationId, applicationId),
        ),
      );
  }

  if (!existing) {
    await assignDefaultRoleIfNeeded(user.id, applicationId);
    await assignDefaultPlanIfNeeded(user.id, applicationId);
    publishEvent("user.changed");
  }
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    created: !existing,
    applicationName: app.name,
    applicationSlug: app.slug,
  };
}
