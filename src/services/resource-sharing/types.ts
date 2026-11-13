import type { sharedResources } from "../../db/schema.js";

export const RESOURCE_STATUSES = ["draft", "published", "disabled"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const RESOURCE_VISIBILITIES = [
  "invited_only",
  "public_catalog",
] as const;
export type ResourceVisibility = (typeof RESOURCE_VISIBILITIES)[number];

export type SharedResource = typeof sharedResources.$inferSelect;

export function isResourceStatus(value: string): value is ResourceStatus {
  return (RESOURCE_STATUSES as readonly string[]).includes(value);
}

export function isResourceVisibility(
  value: string,
): value is ResourceVisibility {
  return (RESOURCE_VISIBILITIES as readonly string[]).includes(value);
}
