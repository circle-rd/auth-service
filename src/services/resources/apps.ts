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
    .innerJoin(
      userApplications,
      and(
        eq(userApplications.applicationId, applications.id),
        eq(userApplications.userId, userId),
        eq(userApplications.isActive, true),
      ),
    )
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

export interface OwnerMemberQuery {
  limit: number;
  offset: number;
}

export interface OwnerMemberPage {
  members: OwnerApplicationMember[];
  hasMore: boolean;
}

export async function listOwnerMembers(
  ownerApplicationId: string,
  query: OwnerMemberQuery,
): Promise<OwnerMemberPage> {
  // Page on distinct users first: a user with several roles must not consume
  // several rows of the limit.
  const userPage = await db
    .selectDistinct({
      userId: userApplications.userId,
      name: userTable.name,
      email: userTable.email,
    })
    .from(userApplications)
    .innerJoin(userTable, eq(userTable.id, userApplications.userId))
    .where(eq(userApplications.applicationId, ownerApplicationId))
    .orderBy(asc(userTable.name), asc(userTable.email))
    .limit(query.limit + 1)
    .offset(query.offset);
  const hasMore = userPage.length > query.limit;
  const page = userPage.slice(0, query.limit);
  if (page.length === 0) return { members: [], hasMore: false };

  const rows = await db
    .select({
      userId: userApplications.userId,
      isActive: userApplications.isActive,
      role: appRoles.name,
    })
    .from(userApplications)
    .leftJoin(
      userAppRoles,
      and(
        eq(userAppRoles.userId, userApplications.userId),
        eq(userAppRoles.applicationId, userApplications.applicationId),
      ),
    )
    .leftJoin(appRoles, eq(userAppRoles.roleId, appRoles.id))
    .where(
      and(
        eq(userApplications.applicationId, ownerApplicationId),
        inArray(
          userApplications.userId,
          page.map((row) => row.userId),
        ),
      ),
    );

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
      name: "",
      email: "",
      isActive: row.isActive,
      roles: row.role ? [row.role] : [],
    });
  }
  const members: OwnerApplicationMember[] = [];
  for (const row of page) {
    const member = byUser.get(row.userId);
    if (!member) continue;
    member.name = row.name;
    member.email = row.email;
    members.push(member);
  }
  return { members, hasMore };
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

  const inserted = await db
    .insert(userApplications)
    .values({ userId: user.id, applicationId, isActive: true })
    .onConflictDoNothing({
      target: [userApplications.userId, userApplications.applicationId],
    })
    .returning({ id: userApplications.id });
  const created = inserted.length > 0;
  if (!created) {
    // A concurrent request may have created the row, or reactivated it.
    await db
      .update(userApplications)
      .set({ isActive: true })
      .where(
        and(
          eq(userApplications.userId, user.id),
          eq(userApplications.applicationId, applicationId),
          eq(userApplications.isActive, false),
        ),
      );
  }

  if (created) {
    await assignDefaultRoleIfNeeded(user.id, applicationId);
    await assignDefaultPlanIfNeeded(user.id, applicationId);
    publishEvent("user.changed");
  }
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    created,
    applicationName: app.name,
    applicationSlug: app.slug,
  };
}
