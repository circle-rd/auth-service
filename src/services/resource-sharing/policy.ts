import { planTeamId, resolveGatewayPlan } from "../litellm-plan.js";
import { normalizeResourceKey, type ResourceType } from "../resource-uri.js";
import { findLatestGrant, hasActiveMembership } from "./grants.js";
import { findResourceByKey } from "./registry.js";

export type DenialReason =
  | "invalid_input"
  | "not_found"
  | "type_mismatch"
  | "key_mismatch"
  | "disabled"
  | "not_published"
  | "no_grant"
  | "revoked"
  | "expired"
  | "client_not_allowed"
  | "no_plan";

export interface AuthorizeInput {
  subjectId: string;
  clientId: string;
  resourceType: ResourceType;
  key: string;
  audience: string;
}

export interface PolicyResource {
  id: string;
  key: string;
  resourceType: ResourceType;
  status: string;
  ownerApplicationId: string;
  ownerApplicationSlug: string;
}

export interface PolicyGrant {
  kind: "membership" | "explicit";
  planName: string | null;
  allowedClientIds: string[] | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface PolicyFacts {
  resource: PolicyResource | null;
  grant: PolicyGrant | null;
  now?: Date;
}

export interface AllowDecision {
  decision: "allow";
  resourceId: string;
  resourceKey: string;
  ownerApplicationId: string;
  ownerApplicationSlug: string;
  planName: string;
  teamId: string;
  subjectId: string;
  clientId: string;
  resourceType: ResourceType;
  grantKind: "membership" | "explicit";
}

export interface DenyDecision {
  decision: "deny";
  reason: DenialReason;
}

export type AuthorizationDecision = AllowDecision | DenyDecision;

export function deny(reason: DenialReason): DenyDecision {
  return { decision: "deny", reason };
}

function isNonEmpty(value: string): boolean {
  return value.trim() !== "";
}

export function evaluatePolicy(
  input: AuthorizeInput,
  facts: PolicyFacts,
): AuthorizationDecision {
  if (
    !isNonEmpty(input.subjectId) ||
    !isNonEmpty(input.clientId) ||
    !isNonEmpty(input.audience) ||
    !isNonEmpty(input.key)
  ) {
    return deny("invalid_input");
  }

  const { resource, grant } = facts;
  const now = facts.now ?? new Date();
  if (!resource) return deny("not_found");
  if (resource.resourceType !== input.resourceType)
    return deny("type_mismatch");
  if (resource.key !== input.key) return deny("key_mismatch");
  if (resource.status === "disabled") return deny("disabled");
  if (resource.status !== "published") return deny("not_published");
  if (!grant) return deny("no_grant");
  if (grant.revokedAt !== null) return deny("revoked");
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime()) {
    return deny("expired");
  }
  if (
    grant.allowedClientIds !== null &&
    !grant.allowedClientIds.includes(input.clientId)
  ) {
    return deny("client_not_allowed");
  }
  if (grant.planName === null) return deny("no_plan");

  return {
    decision: "allow",
    resourceId: resource.id,
    resourceKey: resource.key,
    ownerApplicationId: resource.ownerApplicationId,
    ownerApplicationSlug: resource.ownerApplicationSlug,
    planName: grant.planName,
    teamId: planTeamId(resource.ownerApplicationSlug, grant.planName),
    subjectId: input.subjectId,
    clientId: input.clientId,
    resourceType: resource.resourceType,
    grantKind: grant.kind,
  };
}

async function loadGrant(
  resource: PolicyResource,
  subjectId: string,
): Promise<PolicyGrant | null> {
  if (await hasActiveMembership(subjectId, resource.ownerApplicationId)) {
    const plan = await resolveGatewayPlan(
      subjectId,
      resource.ownerApplicationSlug,
    );
    return {
      kind: "membership",
      planName: plan?.planName ?? null,
      allowedClientIds: null,
      expiresAt: null,
      revokedAt: null,
    };
  }

  const grant = await findLatestGrant(
    subjectId,
    resource.ownerApplicationId,
    resource.id,
  );
  if (!grant) return null;
  return {
    kind: "explicit",
    planName: grant.planName,
    allowedClientIds: grant.allowedClientIds,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
  };
}

export async function authorizeResource(
  resource: PolicyResource | null,
  input: AuthorizeInput,
  now: Date = new Date(),
): Promise<AuthorizationDecision> {
  if (!resource) return deny("not_found");
  const grant = await loadGrant(resource, input.subjectId);
  return evaluatePolicy(input, { resource, grant, now });
}

export async function authorize(
  input: AuthorizeInput,
): Promise<AuthorizationDecision> {
  if (
    !isNonEmpty(input.subjectId) ||
    !isNonEmpty(input.clientId) ||
    !isNonEmpty(input.audience) ||
    !isNonEmpty(input.key)
  ) {
    return deny("invalid_input");
  }

  let key: string;
  try {
    key = normalizeResourceKey(input.key).key;
  } catch {
    return deny("invalid_input");
  }

  const resource = await findResourceByKey(key);
  if (!resource) return deny("not_found");
  if (resource.resourceType !== input.resourceType) {
    return deny("type_mismatch");
  }
  return authorizeResource(resource, { ...input, key });
}
