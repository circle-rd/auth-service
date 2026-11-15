import { isActiveMember, isApplicationAdmin } from "./authority.js";
import { resolveGrantsForSubject } from "./grants.js";
import { findResourceByUri, type ResourceView } from "./registry.js";
import { isSchemeEnabledForApplication } from "./scheme-service.js";
import type { ResourceSubjectType } from "./types.js";
import { parseResourceUri } from "./uri.js";

export type DenialReason =
  | "invalid_input"
  | "not_found"
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

/**
 * Membership is the gate; ownership, an application-admin role or an active
 * grant is the admission. The scheme must still be enabled for the resource
 * application and the resource must have been validated.
 */
export async function evaluateResourceAccess(
  facts: AccessFacts,
): Promise<AccessDecision> {
  const { resource, subjectId } = facts;
  if (resource.status === "disabled") return deny("disabled");
  if (resource.status !== "validated") return deny("not_validated");
  if (
    !(await isSchemeEnabledForApplication(
      resource.applicationId,
      resource.scheme,
    ))
  ) {
    return deny("scheme_disabled");
  }
  if (!(await isActiveMember(subjectId, resource.applicationId))) {
    return deny("no_membership");
  }
  if (resource.ownerType === "user" && resource.ownerId === subjectId) {
    return allow(resource, "owner");
  }
  if (await isApplicationAdmin(subjectId, resource.applicationId)) {
    return allow(resource, "admin");
  }
  const grants = await resolveGrantsForSubject(
    subjectId,
    resource.id,
    facts.now ?? new Date(),
  );
  const grant = grants[0];
  if (!grant) return deny("no_grant");
  return allow(resource, "grant", grant.subjectType);
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
