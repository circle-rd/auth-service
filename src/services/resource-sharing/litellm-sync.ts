/**
 * Keeps the owner plan access groups in line with published shared resources.
 *
 * Only the owner application's plan groups (`<ownerSlug>:<planSlug>`) are
 * touched. Membership entries for shared resources are merged in or removed;
 * groups are never created or deleted and operator-added entries survive. A
 * workflow/MCP resource maps to its LiteLLM id held opaquely in `upstream_ref`;
 * a model maps to the canonical key (its model-group name).
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  sharedResources,
  subscriptionPlans,
} from "../../db/schema.js";
import { logger } from "../../logger.js";
import { gatewayUrl } from "../litellm-sync.js";
import { planTeamId } from "../litellm-plan.js";
import type { ResourceType } from "../resource-uri.js";
import type { ResourceStatus } from "./types.js";
import {
  LitellmResourceSyncError,
  isResourceSyncActive,
  listAccessGroups,
  updateAccessGroupMembers,
  type AccessGroupMembersPatch,
  type ResourceAccessGroup,
} from "./litellm-sync-client.js";

export { assertResourceSyncReady } from "./litellm-sync-client.js";

export const RESOURCE_SYNC_INTERVAL_MS = 5 * 60_000;

type MemberField =
  "access_model_names" | "access_mcp_server_ids" | "access_agent_ids";

interface EntityRef {
  field: MemberField;
  value: string;
  resourceId: string;
}

interface ResourceRow {
  resourceId: string;
  ownerApplicationId: string;
  ownerSlug: string;
  allowedResources: string[];
  resourceType: ResourceType;
  key: string;
  upstreamRef: string | null;
  status: ResourceStatus;
}

interface PlanRow {
  applicationId: string;
  name: string;
}

export interface ResourceSyncReport {
  updated: number;
  unchanged: number;
  skippedGroups: number;
  failed: number;
}

const EMPTY_REPORT: ResourceSyncReport = {
  updated: 0,
  unchanged: 0,
  skippedGroups: 0,
  failed: 0,
};

function entityRefs(resource: ResourceRow): EntityRef[] {
  switch (resource.resourceType) {
    case "model":
      return [
        {
          field: "access_model_names",
          value: resource.key,
          resourceId: resource.resourceId,
        },
      ];
    case "workflow": {
      const id = resource.upstreamRef?.trim();
      return id
        ? [
            {
              field: "access_agent_ids",
              value: id,
              resourceId: resource.resourceId,
            },
          ]
        : [];
    }
    case "mcp_agent": {
      const id = resource.upstreamRef?.trim();
      return id
        ? [
            {
              field: "access_mcp_server_ids",
              value: id,
              resourceId: resource.resourceId,
            },
          ]
        : [];
    }
    case "https_endpoint":
      return [];
  }
}

function groupMembers(
  group: ResourceAccessGroup,
): Record<MemberField, string[]> {
  return {
    access_model_names: group.modelNames,
    access_mcp_server_ids: group.mcpServerIds,
    access_agent_ids: group.agentIds,
  };
}

/**
 * Remove the managed entries no longer desired, then append the desired ones.
 * Entries auth-service never managed are preserved verbatim.
 */
function mergedMembers(
  current: string[],
  managed: Set<string>,
  desired: string[],
): string[] {
  const desiredSet = new Set(desired);
  const removed = new Set([...managed].filter((id) => !desiredSet.has(id)));
  const next = current.filter((id) => !removed.has(id));
  for (const id of desired) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function patchFor(
  group: ResourceAccessGroup,
  desired: Map<MemberField, Set<string>>,
  managed: Map<MemberField, Set<string>>,
): AccessGroupMembersPatch | null {
  const next: AccessGroupMembersPatch = {};
  const current = groupMembers(group);
  const fields: MemberField[] = [
    "access_model_names",
    "access_mcp_server_ids",
    "access_agent_ids",
  ];
  for (const field of fields) {
    const merged = mergedMembers(
      current[field],
      managed.get(field) ?? new Set(),
      [...(desired.get(field) ?? new Set())],
    );
    if (!sameValues(merged, current[field])) next[field] = merged;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function addRefs(
  target: Map<MemberField, Set<string>>,
  refs: EntityRef[],
): void {
  for (const ref of refs) {
    const set = target.get(ref.field) ?? new Set<string>();
    set.add(ref.value);
    target.set(ref.field, set);
  }
}

function ownerResourcesFor(
  resources: ResourceRow[],
  ownerApplicationId: string,
  gateway: string,
): ResourceRow[] {
  return resources.filter(
    (resource) =>
      resource.ownerApplicationId === ownerApplicationId &&
      resource.allowedResources.includes(gateway),
  );
}

async function syncOwner(
  ownerApplicationId: string,
  resources: ResourceRow[],
  plans: PlanRow[],
  groups: Map<string, ResourceAccessGroup>,
  gateway: string,
  report: ResourceSyncReport,
): Promise<void> {
  const owned = ownerResourcesFor(resources, ownerApplicationId, gateway);
  if (owned.length === 0) return;
  const ownerSlug = owned[0]?.ownerSlug;
  if (!ownerSlug) return;

  const managed = new Map<MemberField, Set<string>>();
  const desired = new Map<MemberField, Set<string>>();
  for (const resource of owned) {
    const refs = entityRefs(resource);
    if (
      (resource.resourceType === "workflow" ||
        resource.resourceType === "mcp_agent") &&
      resource.status === "published" &&
      refs.length === 0
    ) {
      report.failed += 1;
      logger.error(
        {
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
          reason: "missing_upstream_ref",
        },
        "[res] published resource cannot be synced to LiteLLM",
      );
      continue;
    }
    addRefs(managed, refs);
    if (resource.status === "published") addRefs(desired, refs);
  }

  const ownerPlans = plans.filter(
    (p) => p.applicationId === ownerApplicationId,
  );
  for (const plan of ownerPlans) {
    const group = groups.get(planTeamId(ownerSlug, plan.name));
    if (!group) {
      report.skippedGroups += 1;
      continue;
    }
    const patch = patchFor(group, desired, managed);
    if (!patch) {
      report.unchanged += 1;
      continue;
    }
    try {
      await updateAccessGroupMembers(group.id, patch);
      report.updated += 1;
    } catch (err) {
      report.failed += 1;
      const failure =
        err instanceof LitellmResourceSyncError
          ? err.message
          : "unexpected gateway error";
      if (err instanceof LitellmResourceSyncError && err.transient) {
        logger.warn({ failure }, "[res] access-group sync will be retried");
      } else {
        logger.error({ failure }, "[res] access-group sync failed");
      }
    }
  }
}

async function loadResources(
  ownerApplicationId?: string,
): Promise<ResourceRow[]> {
  return db
    .select({
      resourceId: sharedResources.id,
      ownerApplicationId: sharedResources.ownerApplicationId,
      ownerSlug: applications.slug,
      allowedResources: applications.allowedResources,
      resourceType: sharedResources.resourceType,
      key: sharedResources.key,
      upstreamRef: sharedResources.upstreamRef,
      status: sharedResources.status,
    })
    .from(sharedResources)
    .innerJoin(
      applications,
      eq(sharedResources.ownerApplicationId, applications.id),
    )
    .where(
      ownerApplicationId
        ? eq(sharedResources.ownerApplicationId, ownerApplicationId)
        : undefined,
    );
}

async function loadPlans(ownerIds: string[]): Promise<PlanRow[]> {
  return db
    .select({
      applicationId: subscriptionPlans.applicationId,
      name: subscriptionPlans.name,
    })
    .from(subscriptionPlans)
    .where(inArray(subscriptionPlans.applicationId, ownerIds));
}

/**
 * Converge the access groups of every (or one) owner application. Reads the
 * registry and the gateway only; never creates or deletes a group.
 */
export async function reconcileSharedResources(options?: {
  ownerApplicationId?: string;
}): Promise<ResourceSyncReport> {
  const report: ResourceSyncReport = { ...EMPTY_REPORT };
  if (!isResourceSyncActive()) return report;

  const gateway = await gatewayUrl();
  if (!gateway) return report;

  const resources = await loadResources(options?.ownerApplicationId);
  if (resources.length === 0) return report;

  const ownerIds = [
    ...new Set(
      resources
        .filter((resource) => resource.allowedResources.includes(gateway))
        .map((resource) => resource.ownerApplicationId),
    ),
  ];
  if (ownerIds.length === 0) return report;

  const plans = await loadPlans(ownerIds);
  let groups: Map<string, ResourceAccessGroup>;
  try {
    groups = new Map(
      (await listAccessGroups()).map((group) => [group.name, group]),
    );
  } catch (err) {
    report.failed += 1;
    const failure =
      err instanceof LitellmResourceSyncError
        ? err.message
        : "unexpected gateway error";
    logger.warn({ failure }, "[res] could not list gateway access groups");
    return report;
  }

  for (const ownerId of ownerIds) {
    await syncOwner(ownerId, resources, plans, groups, gateway, report);
  }
  return report;
}

function anyChange(report: ResourceSyncReport): boolean {
  return report.updated > 0 || report.skippedGroups > 0 || report.failed > 0;
}

/** Fire-and-forget convergence after a registry write; the loop retries. */
export function queueOwnerResourceSync(ownerApplicationId: string): void {
  if (!isResourceSyncActive()) return;
  void reconcileSharedResources({ ownerApplicationId }).then(
    (report) => {
      if (anyChange(report)) {
        logger.info(report, "[res] shared-resource access groups reconciled");
      }
    },
    (err: unknown) =>
      logger.warn(
        { failure: err instanceof Error ? err.message : "unexpected error" },
        "[res] shared-resource access-group reconcile failed",
      ),
  );
}

/** Reconcile now (in the background) and every five minutes. Never throws. */
export function startResourceSync(): void {
  if (!isResourceSyncActive()) return;
  const run = () =>
    reconcileSharedResources().then(
      (report) => {
        if (anyChange(report)) {
          logger.info(report, "[res] shared-resource access groups reconciled");
        }
      },
      (err: unknown) =>
        logger.warn(
          { failure: err instanceof Error ? err.message : "unexpected error" },
          "[res] shared-resource access-group reconcile failed",
        ),
    );
  void run();
  setInterval(run, RESOURCE_SYNC_INTERVAL_MS).unref();
}
