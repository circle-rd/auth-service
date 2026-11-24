export const RESOURCE_SCHEME_SOURCES = ["builtin", "application"] as const;
export type ResourceSchemeSource = (typeof RESOURCE_SCHEME_SOURCES)[number];

export const RESOURCE_ADAPTERS = [
  "litellm",
  "ssh",
  "http",
  "file",
  "external",
] as const;
export type ResourceAdapter = (typeof RESOURCE_ADAPTERS)[number];

export const RESOURCE_SCHEME_OWNER_TYPES = ["platform", "application"] as const;
export type ResourceSchemeOwnerType =
  (typeof RESOURCE_SCHEME_OWNER_TYPES)[number];

export const RESOURCE_SCHEME_STATUSES = ["active", "disabled"] as const;
export type ResourceSchemeStatus = (typeof RESOURCE_SCHEME_STATUSES)[number];

export const RESOURCE_OWNER_TYPES = ["user", "application"] as const;
export type ResourceOwnerType = (typeof RESOURCE_OWNER_TYPES)[number];

export const RESOURCE_STATUSES = [
  "pending_validation",
  "validation_failed",
  "validated",
  "disabled",
] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const RESOURCE_SUBJECT_TYPES = [
  "user",
  "organization",
  "plan",
  "everyone",
  "application",
] as const;
export type ResourceSubjectType = (typeof RESOURCE_SUBJECT_TYPES)[number];

// Ordered from the weakest to the strongest: `write` covers `read`.
export const RESOURCE_PERMISSIONS = ["read", "write"] as const;
export type ResourcePermission = (typeof RESOURCE_PERMISSIONS)[number];

export function permissionCovers(
  held: ResourcePermission,
  required: ResourcePermission,
): boolean {
  return (
    RESOURCE_PERMISSIONS.indexOf(held) >= RESOURCE_PERMISSIONS.indexOf(required)
  );
}

/** The weaker of two levels. */
export function capPermission(
  a: ResourcePermission,
  b: ResourcePermission,
): ResourcePermission {
  return permissionCovers(a, b) ? b : a;
}

/** The stronger of two levels. */
export function raisePermission(
  a: ResourcePermission,
  b: ResourcePermission,
): ResourcePermission {
  return permissionCovers(a, b) ? a : b;
}

export const RESOURCE_EVENT_DECISIONS = ["allow", "deny"] as const;
export type ResourceEventDecision = (typeof RESOURCE_EVENT_DECISIONS)[number];

export const RESOURCE_EVENT_SOURCES = [
  "gateway",
  "ssh",
  "external",
  "api",
] as const;
export type ResourceEventSource = (typeof RESOURCE_EVENT_SOURCES)[number];

export const RESOURCE_USAGE_SOURCES = ["provider", "unsupported"] as const;
export type ResourceUsageSource = (typeof RESOURCE_USAGE_SOURCES)[number];

export function isResourceSchemeSource(
  value: string,
): value is ResourceSchemeSource {
  return (RESOURCE_SCHEME_SOURCES as readonly string[]).includes(value);
}

export function isResourceAdapter(value: string): value is ResourceAdapter {
  return (RESOURCE_ADAPTERS as readonly string[]).includes(value);
}

export function isResourceStatus(value: string): value is ResourceStatus {
  return (RESOURCE_STATUSES as readonly string[]).includes(value);
}

export function isResourceSubjectType(
  value: string,
): value is ResourceSubjectType {
  return (RESOURCE_SUBJECT_TYPES as readonly string[]).includes(value);
}
