import { ApiError } from "../../errors.js";
import { createResourceGrant } from "./grants.js";
import type { ResourcePermission } from "./types.js";

export const BULK_SHARE_LIMIT = 100;

export interface BulkShareInput {
  resourceIds: readonly string[];
  applicationSlug: string;
  permission?: ResourcePermission;
  expiresAt?: Date | null;
  actorUserId: string;
}

/** One outcome per resource: a grant id, or the error code that refused it. */
export interface BulkShareResult {
  resourceId: string;
  grantId: string | null;
  code: string | null;
}

/**
 * Share several resources with one application. Each resource goes through the
 * same authority and target checks as a single grant, and a refusal is
 * reported for that resource instead of stopping the others.
 */
export async function shareResourcesWithApplication(
  input: BulkShareInput,
): Promise<BulkShareResult[]> {
  const results: BulkShareResult[] = [];
  for (const resourceId of input.resourceIds) {
    try {
      const grant = await createResourceGrant({
        resourceId,
        subjectType: "application",
        subjectId: input.applicationSlug,
        actorUserId: input.actorUserId,
        permission: input.permission,
        expiresAt: input.expiresAt,
      });
      results.push({ resourceId, grantId: grant.id, code: null });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      results.push({ resourceId, grantId: null, code: err.code });
    }
  }
  return results;
}
