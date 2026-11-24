import { and, isNotNull, lt, or } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import {
  resourceGrants,
  resourceInvitations,
} from "../../db/resource-schema.js";
import { logger } from "../../logger.js";

/**
 * Delete the grants that stopped counting (revoked, or past their expiry) and
 * the invitations that are spent (consumed, revoked or expired) once they are
 * older than the retention period. An active grant or a pending invitation is
 * never touched, whatever its age.
 */
export async function sweepResourceGrantRetention(
  now: Date = new Date(),
): Promise<{ grants: number; invitations: number }> {
  const cutoff = new Date(
    now.getTime() - config.resources.grantRetentionDays * 86_400_000,
  );
  const grants = await db
    .delete(resourceGrants)
    .where(
      or(
        and(
          isNotNull(resourceGrants.revokedAt),
          lt(resourceGrants.revokedAt, cutoff),
        ),
        and(
          isNotNull(resourceGrants.expiresAt),
          lt(resourceGrants.expiresAt, cutoff),
        ),
      ),
    )
    .returning({ id: resourceGrants.id });
  const invitations = await db
    .delete(resourceInvitations)
    .where(
      or(
        and(
          isNotNull(resourceInvitations.consumedAt),
          lt(resourceInvitations.consumedAt, cutoff),
        ),
        and(
          isNotNull(resourceInvitations.revokedAt),
          lt(resourceInvitations.revokedAt, cutoff),
        ),
        lt(resourceInvitations.expiresAt, cutoff),
      ),
    )
    .returning({ id: resourceInvitations.id });
  if (grants.length > 0 || invitations.length > 0) {
    logger.info(
      { grants: grants.length, invitations: invitations.length },
      "[res] grant retention sweep",
    );
  }
  return { grants: grants.length, invitations: invitations.length };
}
