import { config } from "../../config.js";
import { isActiveMember } from "./authority.js";
import { isAccountActive } from "./identity-facts.js";
import {
  GLOBAL_SCOPE,
  applicationScope,
  applicationScopeLevel,
  loadSharingApplication,
  type AccessScope,
  type CallerApplication,
  type SharingApplication,
} from "./application-scope.js";
import {
  resolveApplicationGrants,
  resolveGrantsForSubject,
} from "./grant-resolution.js";
import type { ResourceGrantRow } from "./grants.js";
import { findResourceByUri, type ResourceView } from "./registry.js";
import { isSchemeEnabledForApplication } from "./scheme-service.js";
import {
  capPermission,
  permissionCovers,
  type ResourcePermission,
  type ResourceSubjectType,
} from "./types.js";
import { parseResourceUri } from "./uri.js";

export type DenialReason =
  | "invalid_input"
  | "invalid_client"
  | "invalid_audience"
  | "not_found"
  | "application_inactive"
  | "sharing_disabled"
  | "account_disabled"
  | "no_membership"
  | "scheme_disabled"
  | "not_validated"
  | "disabled"
  | "not_in_scope"
  | "no_grant"
  | "insufficient_permission";

export interface AuthorizeInput {
  subjectId: string;
  // The verified machine client: it comes from the token, never from a body.
  caller: CallerApplication;
  resourceUri: string;
  audience: string;
  permission?: ResourcePermission;
}

export interface AccessFacts {
  resource: ResourceView;
  subjectId: string;
  scope?: AccessScope;
  permission?: ResourcePermission;
  now?: Date;
}

export type AccessKind = "owner" | "grant";

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
  permission: ResourcePermission;
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
  permission: ResourcePermission,
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
    permission,
    grantSubjectType,
  };
}

/** The strongest grant wins; the first one of that level names the subject type. */
function strongestGrant(grants: readonly ResourceGrantRow[]) {
  let best: ResourceGrantRow | undefined;
  for (const grant of grants) {
    if (!best || !permissionCovers(best.permission, grant.permission)) {
      best = grant;
    }
  }
  return best;
}

export interface AccessProvider {
  schemeEnabled: () => Promise<boolean>;
  // The level the calling application holds on the resource, null when none.
  scopeLevel: () => Promise<ResourcePermission | null>;
  accountActive: () => Promise<boolean>;
  activeMember: () => Promise<boolean>;
  isOwner: () => boolean;
  // Grants that apply to the person: user, organization, plan and everyone.
  grants: () => Promise<ResourceGrantRow[]>;
}

/**
 * The effective level is the lower of what the person holds and what the
 * calling application holds: an application grant never widens the person's
 * own right, and the person's right never widens the application's.
 */
export async function decide(
  resource: ResourceView,
  provider: AccessProvider,
  required: ResourcePermission,
): Promise<AccessDecision> {
  // Static state first: a disabled or unshared resource never needs a query.
  if (resource.status === "disabled") return deny("disabled");
  if (resource.status !== "validated") return deny("not_validated");
  if (!resource.applicationActive) return deny("application_inactive");
  if (!resource.resourceSharingEnabled) return deny("sharing_disabled");
  if (!(await provider.schemeEnabled())) return deny("scheme_disabled");
  const scope = await provider.scopeLevel();
  if (scope === null) return deny("not_in_scope");
  if (!(await provider.accountActive())) return deny("account_disabled");
  if (!(await provider.activeMember())) return deny("no_membership");

  let subjectLevel: ResourcePermission;
  let accessKind: AccessKind;
  let grantSubjectType: ResourceSubjectType | undefined;
  if (provider.isOwner()) {
    subjectLevel = "write";
    accessKind = "owner";
  } else {
    const grant = strongestGrant(await provider.grants());
    if (!grant) return deny("no_grant");
    subjectLevel = grant.permission;
    accessKind = "grant";
    grantSubjectType = grant.subjectType;
  }
  const effective = capPermission(subjectLevel, scope);
  if (!permissionCovers(effective, required)) {
    return deny("insufficient_permission");
  }
  return allow(resource, accessKind, effective, grantSubjectType);
}

/**
 * Membership is the gate; ownership or an active grant is the admission.
 * An administrator is not a recipient: nothing here admits one implicitly.
 * The resource application must also keep sharing enabled, and the scheme
 * must be active for it. Through an application, membership is that of the
 * calling application and only the application's scope is reachable.
 */
export async function evaluateResourceAccess(
  facts: AccessFacts,
): Promise<AccessDecision> {
  const { resource, subjectId } = facts;
  const scope = facts.scope ?? GLOBAL_SCOPE;
  const now = facts.now ?? new Date();
  const caller = scope.kind === "application" ? scope.caller : null;
  return decide(
    resource,
    {
      schemeEnabled: () =>
        isSchemeEnabledForApplication(resource.applicationId, resource.scheme),
      scopeLevel: async () => {
        if (!caller) return "write";
        if (resource.applicationId === caller.id) return "write";
        return applicationScopeLevel(
          resource.applicationId,
          caller,
          await resolveApplicationGrants(resource.id, caller.slug, now),
        );
      },
      accountActive: () => isAccountActive(subjectId, now),
      activeMember: () =>
        isActiveMember(subjectId, caller?.id ?? resource.applicationId),
      isOwner: () =>
        resource.ownerType === "user" && resource.ownerId === subjectId,
      grants: () =>
        resolveGrantsForSubject(subjectId, resource.id, now, {
          includePlans: !caller || caller.id === resource.applicationId,
        }),
    },
    facts.permission ?? "read",
  );
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

/** The issuer, or a resource server the application is allowed to reach. */
function audienceAllowed(
  audience: string,
  application: SharingApplication,
): boolean {
  const wanted = trimTrailingSlash(audience);
  return [config.betterAuth.url, ...application.allowedResources].some(
    (allowed) => trimTrailingSlash(allowed) === wanted,
  );
}

export async function authorize(
  input: AuthorizeInput,
): Promise<AccessDecision> {
  if (
    !isNonEmpty(input.subjectId) ||
    !isNonEmpty(input.caller.slug) ||
    !isNonEmpty(input.audience) ||
    !isNonEmpty(input.resourceUri)
  ) {
    return deny("invalid_input");
  }
  const application = await loadSharingApplication(input.caller.id);
  if (!application || application.slug !== input.caller.slug) {
    return deny("invalid_client");
  }
  if (!audienceAllowed(input.audience, application)) {
    return deny("invalid_audience");
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
    scope: applicationScope(input.caller),
    permission: input.permission,
  });
}
