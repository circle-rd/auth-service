import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userApplications, userSubscriptions } from "../../db/schema.js";
import { member, user as userTable } from "../../db/auth-schema.js";
import {
  applicationSchemes,
  resourceGrants,
  resourceSchemes,
} from "../../db/resource-schema.js";
import {
  GLOBAL_SCOPE,
  applicationScopeLevel,
  type AccessScope,
} from "./application-scope.js";
import type { ResourceGrantRow } from "./grants.js";
import { decide, isBanned, type AccessDecision } from "./policy.js";
import type { ResourceView } from "./registry.js";

interface BatchAccessContext {
  subjectId: string;
  scope: AccessScope;
  accountActive: boolean;
  memberships: Set<string>;
  enabledSchemes: Set<string>;
  organizationIds: Set<string>;
  planIds: Map<string, Set<string>>;
  grants: Map<string, ResourceGrantRow[]>;
}

function schemeKey(applicationId: string, scheme: string): string {
  return `${applicationId}\u0000${scheme}`;
}

/** Person-level grants only: application grants decide the scope, not the person. */
function grantApplies(
  grant: ResourceGrantRow,
  resource: ResourceView,
  context: BatchAccessContext,
): boolean {
  if (grant.subjectType === "everyone") return true;
  if (grant.subjectType === "user") {
    return grant.subjectId === context.subjectId;
  }
  if (grant.subjectType === "organization") {
    return (
      grant.subjectId !== null && context.organizationIds.has(grant.subjectId)
    );
  }
  if (grant.subjectType === "plan") {
    // Plans belong to the owner application.
    const viaOwnerApplication =
      context.scope.kind === "global" ||
      context.scope.caller.id === resource.applicationId;
    return (
      viaOwnerApplication &&
      grant.subjectId !== null &&
      (context.planIds.get(resource.applicationId)?.has(grant.subjectId) ??
        false)
    );
  }
  return false;
}

async function loadBatchAccessContext(
  subjectId: string,
  resources: readonly ResourceView[],
  scope: AccessScope,
  now: Date,
): Promise<BatchAccessContext> {
  const applicationIds = [...new Set(resources.map((r) => r.applicationId))];
  const membershipApplicationIds =
    scope.kind === "application" ? [scope.caller.id] : applicationIds;
  const resourceIds = resources.map((r) => r.id);

  const [
    platformRows,
    membershipRows,
    schemeRows,
    organizationRows,
    planRows,
    grantRows,
  ] = await Promise.all([
    db
      .select({
        banned: userTable.banned,
        banExpires: userTable.banExpires,
      })
      .from(userTable)
      .where(eq(userTable.id, subjectId))
      .limit(1),
    db
      .select({ applicationId: userApplications.applicationId })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, subjectId),
          eq(userApplications.isActive, true),
          inArray(userApplications.applicationId, membershipApplicationIds),
        ),
      ),
    db
      .select({
        applicationId: applicationSchemes.applicationId,
        scheme: applicationSchemes.scheme,
      })
      .from(applicationSchemes)
      .innerJoin(
        resourceSchemes,
        eq(applicationSchemes.scheme, resourceSchemes.scheme),
      )
      .where(
        and(
          inArray(applicationSchemes.applicationId, applicationIds),
          eq(applicationSchemes.enabled, true),
          eq(resourceSchemes.status, "active"),
        ),
      ),
    db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, subjectId)),
    db
      .select({
        applicationId: userSubscriptions.applicationId,
        planId: userSubscriptions.planId,
      })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, subjectId),
          inArray(userSubscriptions.applicationId, applicationIds),
          eq(userSubscriptions.isActive, true),
          or(
            isNull(userSubscriptions.expiresAt),
            gt(userSubscriptions.expiresAt, now),
          ),
        ),
      ),
    db
      .select()
      .from(resourceGrants)
      .where(
        and(
          inArray(resourceGrants.resourceId, resourceIds),
          isNull(resourceGrants.revokedAt),
          or(
            isNull(resourceGrants.expiresAt),
            gt(resourceGrants.expiresAt, now),
          ),
        ),
      ),
  ]);

  const accountActive =
    platformRows[0] !== undefined && !isBanned(platformRows[0], now);

  const planIds = new Map<string, Set<string>>();
  for (const row of planRows) {
    let ids = planIds.get(row.applicationId);
    if (!ids) {
      ids = new Set<string>();
      planIds.set(row.applicationId, ids);
    }
    ids.add(row.planId);
  }

  const grants = new Map<string, ResourceGrantRow[]>();
  for (const grant of grantRows) {
    const rows = grants.get(grant.resourceId);
    if (rows) rows.push(grant);
    else grants.set(grant.resourceId, [grant]);
  }

  return {
    subjectId,
    scope,
    accountActive,
    memberships: new Set(membershipRows.map((row) => row.applicationId)),
    enabledSchemes: new Set(
      schemeRows.map((row) => schemeKey(row.applicationId, row.scheme)),
    ),
    organizationIds: new Set(
      organizationRows
        .map((row) => row.organizationId)
        .filter((id): id is string => id !== null),
    ),
    planIds,
    grants,
  };
}

export interface BatchAccessOptions {
  scope?: AccessScope;
  now?: Date;
}

/**
 * Evaluate many resources with one set of membership, scheme, plan and grant
 * queries. Used by the catalogue and entitlement resolver, where per-resource
 * reads would grow with the total number of shared resources.
 */
export async function evaluateResourceAccessBatch(
  resources: readonly ResourceView[],
  subjectId: string,
  options: BatchAccessOptions = {},
): Promise<AccessDecision[]> {
  if (resources.length === 0) return [];
  const scope = options.scope ?? GLOBAL_SCOPE;
  const context = await loadBatchAccessContext(
    subjectId,
    resources,
    scope,
    options.now ?? new Date(),
  );
  const caller = scope.kind === "application" ? scope.caller : null;
  return Promise.all(
    resources.map((resource) => {
      const resourceGrantRows = context.grants.get(resource.id) ?? [];
      return decide(
        resource,
        {
          schemeEnabled: async () =>
            context.enabledSchemes.has(
              schemeKey(resource.applicationId, resource.scheme),
            ),
          scopeLevel: async () =>
            caller
              ? applicationScopeLevel(
                  resource.applicationId,
                  caller,
                  resourceGrantRows,
                )
              : "write",
          accountActive: async () => context.accountActive,
          activeMember: async () =>
            context.memberships.has(caller?.id ?? resource.applicationId),
          isOwner: () =>
            resource.ownerType === "user" && resource.ownerId === subjectId,
          grants: async () =>
            resourceGrantRows.filter((grant) =>
              grantApplies(grant, resource, context),
            ),
        },
        "read",
      );
    }),
  );
}
