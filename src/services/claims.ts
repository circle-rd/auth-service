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
}

/**
 * Build OIDC custom claims for a user in the context of a specific OAuth client.
 * The clientId maps to applications.slug.
 */
export async function getUserClaims(
  userId: string,
  applicationSlug: string | undefined,
  scopes: string[],
): Promise<UserClaims> {
  if (!applicationSlug) return {};

  const needsRoles = scopes.includes("roles");
  const needsPermissions = scopes.includes("permissions");
  const needsFeatures = scopes.includes("features");

  if (!needsRoles && !needsPermissions && !needsFeatures) return {};

  // Resolve application by slug (slug = oauthClient.clientId)
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.slug, applicationSlug))
    .limit(1);

  if (!app) return {};

  const claims: UserClaims = {};

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
