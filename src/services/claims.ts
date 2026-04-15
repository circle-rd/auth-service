import { db } from "../db/index.js";
import {
  applications,
  appRoles,
  appPermissions,
  appRolePermissions,
  userAppRoles,
  userSubscriptions,
  subscriptionPlans,
  userApplications,
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";

interface UserClaims {
  roles?: string[];
  permissions?: string[];
  features?: Record<string, unknown>;
  email?: string;
  name?: string;
  company?: string;
}

/**
 * Build OIDC custom claims for a user in the context of a specific OAuth client.
 * The clientId maps to applications.slug.
 */
export async function getUserClaims(
  userId: string,
  applicationSlug: string | undefined,
  scopes: string[],
  profile?: { email?: string | null; name?: string | null; company?: string | null },
): Promise<UserClaims> {
  const claims: UserClaims = {};

  // Profile claims come directly from the token — no DB lookup needed
  if (profile) {
    if (scopes.includes("email") && profile.email) claims.email = profile.email;
    if (scopes.includes("profile") && profile.name) claims.name = profile.name;
    if (scopes.includes("profile") && profile.company) claims.company = profile.company;
  }

  if (!applicationSlug) return claims;

  const needsRoles = scopes.includes("roles");
  const needsPermissions = scopes.includes("permissions");
  const needsFeatures = scopes.includes("features");

  if (!needsRoles && !needsPermissions && !needsFeatures) return claims;

  // Resolve application by slug (slug = oauthClient.clientId)
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.slug, applicationSlug))
    .limit(1);

  if (!app) return claims;

  if (needsRoles || needsPermissions) {
    const userRoles = await db
      .select({
        roleName: appRoles.name,
        roleId: appRoles.id,
      })
      .from(userAppRoles)
      .innerJoin(appRoles, eq(userAppRoles.roleId, appRoles.id))
      .where(
        and(
          eq(userAppRoles.userId, userId),
          eq(userAppRoles.applicationId, app.id),
        ),
      );

    if (needsRoles) {
      claims.roles = userRoles.map((r) => r.roleName);
    }

    if (needsPermissions && userRoles.length > 0) {
      const roleIds = userRoles.map((r) => r.roleId);
      const permsRows = await db
        .select({
          resource: appPermissions.resource,
          action: appPermissions.action,
        })
        .from(appRolePermissions)
        .innerJoin(
          appPermissions,
          eq(appRolePermissions.permissionId, appPermissions.id),
        )
        .where(
          roleIds.length === 1
            ? eq(appRolePermissions.roleId, roleIds[0]!)
            : and(...roleIds.map((id) => eq(appRolePermissions.roleId, id))),
        );

      // Build unique permission strings (resource or resource.action for writes)
      const permSet = new Set<string>();
      for (const p of permsRows) {
        if (p.action === "write") {
          permSet.add(`${p.resource}.write`);
        } else {
          permSet.add(p.resource);
        }
      }
      claims.permissions = [...permSet];
    } else if (needsPermissions) {
      claims.permissions = [];
    }
  }

  if (needsFeatures) {
    const [sub] = await db
      .select({
        features: subscriptionPlans.features,
        expiresAt: userSubscriptions.expiresAt,
        isActive: userSubscriptions.isActive,
      })
      .from(userSubscriptions)
      .innerJoin(
        subscriptionPlans,
        eq(userSubscriptions.planId, subscriptionPlans.id),
      )
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.applicationId, app.id),
          eq(userSubscriptions.isActive, true),
        ),
      )
      .limit(1);

    if (sub) {
      const now = new Date();
      const expired = sub.expiresAt !== null && sub.expiresAt < now;
      claims.features = expired
        ? {}
        : ((sub.features as Record<string, unknown>) ?? {});
    } else {
      claims.features = {};
    }
  }

  return claims;
}

/**
 * Verify a user has active access to an application (for consumption endpoint).
 */
export async function userHasAppAccess(
  userId: string,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ isActive: userApplications.isActive })
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

/**
 * Verify a user has active access to an application identified by its slug (OAuth clientId).
 * Used in the OAuth flow where only the clientId (= slug) is available.
 */
export async function userHasAppAccessBySlug(
  userId: string,
  slug: string,
): Promise<boolean> {
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.slug, slug))
    .limit(1);

  if (!app) return false;
  return userHasAppAccess(userId, app.id);
}

/**
 * Assigns the application's default role to a user if:
 *  - the app has a role marked as isDefault = true
 *  - the user does not already have any role for that app
 */
export async function assignDefaultRoleIfNeeded(
  userId: string,
  applicationId: string,
): Promise<void> {
  const [defaultRole] = await db
    .select({ id: appRoles.id })
    .from(appRoles)
    .where(
      and(
        eq(appRoles.applicationId, applicationId),
        eq(appRoles.isDefault, true),
      ),
    )
    .limit(1);

  if (!defaultRole) return;

  // Check if user already has a role for this app
  const [existing] = await db
    .select({ roleId: userAppRoles.roleId })
    .from(userAppRoles)
    .where(
      and(
        eq(userAppRoles.userId, userId),
        eq(userAppRoles.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (existing) return;

  await db
    .insert(userAppRoles)
    .values({ userId, applicationId, roleId: defaultRole.id })
    .onConflictDoNothing();
}

/**
 * Assigns the application's default subscription plan to a user if:
 *  - the app has a plan marked as isDefault = true
 *  - the user does not already have a subscription for that app
 * Also sets userApplications.subscriptionPlanId for convenience.
 */
export async function assignDefaultPlanIfNeeded(
  userId: string,
  applicationId: string,
): Promise<void> {
  const [defaultPlan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.applicationId, applicationId),
        eq(subscriptionPlans.isDefault, true),
      ),
    )
    .limit(1);

  if (!defaultPlan) return;

  // Check if user already has a subscription (active or not)
  const [existing] = await db
    .select({ id: userSubscriptions.id })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (existing) return;

  await db.transaction(async (tx) => {
    await tx.insert(userSubscriptions).values({
      userId,
      applicationId,
      planId: defaultPlan.id,
      isActive: true,
    });
    await tx
      .update(userApplications)
      .set({ subscriptionPlanId: defaultPlan.id })
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.applicationId, applicationId),
        ),
      );
  });
}
