import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  appRoles,
  userAppRoles,
  userApplications,
  userSubscriptions,
} from "../../db/schema.js";
import { member, user as userTable } from "../../db/auth-schema.js";
import {
  applicationSchemes,
  resourceGrants,
  resourceSchemes,
} from "../../db/resource-schema.js";
import { isActiveMember, isApplicationAdmin } from "./authority.js";
import { resolveGrantsForSubject, type ResourceGrantRow } from "./grants.js";
import { findResourceByUri, type ResourceView } from "./registry.js";
import { isSchemeEnabledForApplication } from "./scheme-service.js";
import type { ResourceSubjectType } from "./types.js";
import { parseResourceUri } from "./uri.js";

export type DenialReason =
  | "invalid_input"
  | "not_found"
  | "application_inactive"
  | "sharing_disabled"
  | "no_membership"
  | "scheme_disabled"
  | "not_validated"
  | "disabled"
  | "no_grant";

export interface AuthorizeInput {
  subjectId: string;
  clientId: string;
  resourceUri: string;
  audience: string;
}

export interface AccessFacts {
  resource: ResourceView;
  subjectId: string;
  now?: Date;
}

export type AccessKind = "owner" | "admin" | "grant";

export interface AllowDecision {
  decision: "allow";
  resourceId: string;
  resourceUri: string;
  scheme: string;
  applicationId: string;
  applicationSlug: string;
  ownerType: "user" | "application";
  ownerId: string;
  accessKind: AccessKind;
  grantSubjectType?: ResourceSubjectType;
}

export interface DenyDecision {
  decision: "deny";
  reason: DenialReason;
}

export type AccessDecision = AllowDecision | DenyDecision;

export function deny(reason: DenialReason): DenyDecision {
  return { decision: "deny", reason };
}

function isNonEmpty(value: string): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function allow(
  resource: ResourceView,
  accessKind: AccessKind,
  grantSubjectType?: ResourceSubjectType,
): AllowDecision {
  return {
    decision: "allow",
    resourceId: resource.id,
    resourceUri: resource.uri,
    scheme: resource.scheme,
    applicationId: resource.applicationId,
    applicationSlug: resource.applicationSlug,
    ownerType: resource.ownerType,
    ownerId: resource.ownerId,
    accessKind,
    grantSubjectType,
  };
}

interface AccessProvider {
  schemeEnabled: () => Promise<boolean>;
  activeMember: () => Promise<boolean>;
  isOwner: () => boolean;
  isAdmin: () => Promise<boolean>;
  grants: () => Promise<ResourceGrantRow[]>;
}

async function decide(
  resource: ResourceView,
  provider: AccessProvider,
): Promise<AccessDecision> {
  // Static state first: a disabled or unshared resource never needs a query.
  if (resource.status === "disabled") return deny("disabled");
  if (resource.status !== "validated") return deny("not_validated");
  if (!resource.applicationActive) return deny("application_inactive");
  if (!resource.resourceSharingEnabled) return deny("sharing_disabled");
  if (!(await provider.schemeEnabled())) return deny("scheme_disabled");
  if (!(await provider.activeMember())) return deny("no_membership");
  if (provider.isOwner()) return allow(resource, "owner");
  if (await provider.isAdmin()) return allow(resource, "admin");
  const grant = (await provider.grants())[0];
  if (!grant) return deny("no_grant");
  return allow(resource, "grant", grant.subjectType);
}

/**
 * Membership is the gate; ownership, an application-admin role or an active
 * grant is the admission. The resource application must also keep sharing
 * enabled, and the scheme must be active for it.
 */
export async function evaluateResourceAccess(
  facts: AccessFacts,
): Promise<AccessDecision> {
  const { resource, subjectId } = facts;
  return decide(resource, {
    schemeEnabled: () =>
      isSchemeEnabledForApplication(resource.applicationId, resource.scheme),
    activeMember: () => isActiveMember(subjectId, resource.applicationId),
    isOwner: () =>
      resource.ownerType === "user" && resource.ownerId === subjectId,
    isAdmin: () => isApplicationAdmin(subjectId, resource.applicationId),
    grants: () =>
      resolveGrantsForSubject(subjectId, resource.id, facts.now ?? new Date()),
  });
}

interface BatchAccessContext {
  subjectId: string;
  platformAdmin: boolean;
  memberships: Set<string>;
  adminApplications: Set<string>;
  enabledSchemes: Set<string>;
  organizationIds: Set<string>;
  planIds: Map<string, Set<string>>;
  grants: Map<string, ResourceGrantRow[]>;
}

function schemeKey(applicationId: string, scheme: string): string {
  return `${applicationId}\u0000${scheme}`;
}

function grantApplies(
  grant: ResourceGrantRow,
  applicationId: string,
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
  return (
    grant.subjectId !== null &&
    (context.planIds.get(applicationId)?.has(grant.subjectId) ?? false)
  );
}

async function loadBatchAccessContext(
  subjectId: string,
  resources: readonly ResourceView[],
  now: Date,
): Promise<BatchAccessContext> {
  const applicationIds = [...new Set(resources.map((r) => r.applicationId))];
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
      .select({ role: userTable.role })
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
          inArray(userApplications.applicationId, applicationIds),
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

  const role = platformRows[0]?.role;
  const platformAdmin = role === "admin" || role === "superadmin";

  const adminApplications = new Set<string>();
  if (!platformAdmin) {
    const adminRows = await db
      .select({ applicationId: appRoles.applicationId })
      .from(userAppRoles)
      .innerJoin(
        appRoles,
        and(
          eq(userAppRoles.roleId, appRoles.id),
          eq(appRoles.applicationId, userAppRoles.applicationId),
        ),
      )
      .where(
        and(
          eq(userAppRoles.userId, subjectId),
          inArray(appRoles.applicationId, applicationIds),
          eq(appRoles.name, "admin"),
        ),
      );
    for (const row of adminRows) adminApplications.add(row.applicationId);
  }

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
    platformAdmin,
    memberships: new Set(membershipRows.map((row) => row.applicationId)),
    adminApplications,
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

/**
 * Evaluate many resources with one set of membership, scheme, plan and grant
 * queries. Used by the catalogue and entitlement resolver, where per-resource
 * reads would grow with the total number of shared resources.
 */
export async function evaluateResourceAccessBatch(
  resources: readonly ResourceView[],
  subjectId: string,
  now: Date = new Date(),
): Promise<AccessDecision[]> {
  if (resources.length === 0) return [];
  const context = await loadBatchAccessContext(subjectId, resources, now);
  return Promise.all(
    resources.map((resource) =>
      decide(resource, {
        schemeEnabled: async () =>
          context.enabledSchemes.has(
            schemeKey(resource.applicationId, resource.scheme),
          ),
        activeMember: async () =>
          context.memberships.has(resource.applicationId),
        isOwner: () =>
          resource.ownerType === "user" && resource.ownerId === subjectId,
        isAdmin: async () =>
          context.platformAdmin ||
          context.adminApplications.has(resource.applicationId),
        grants: async () =>
          (context.grants.get(resource.id) ?? []).filter((grant) =>
            grantApplies(grant, resource.applicationId, context),
          ),
      }),
    ),
  );
}

export async function authorizeResource(
  resource: ResourceView | null,
  input: AuthorizeInput,
): Promise<AccessDecision> {
  if (!resource) return deny("not_found");
  return evaluateResourceAccess({
    resource,
    subjectId: input.subjectId,
  });
}

export async function authorize(
  input: AuthorizeInput,
): Promise<AccessDecision> {
  if (
    !isNonEmpty(input.subjectId) ||
    !isNonEmpty(input.clientId) ||
    !isNonEmpty(input.audience) ||
    !isNonEmpty(input.resourceUri)
  ) {
    return deny("invalid_input");
  }
  let parsed;
  try {
    parsed = parseResourceUri(input.resourceUri);
  } catch {
    return deny("invalid_input");
  }
  const resource = await findResourceByUri(parsed.uri);
  if (!resource) return deny("not_found");
  return evaluateResourceAccess({
    resource,
    subjectId: input.subjectId,
  });
}
