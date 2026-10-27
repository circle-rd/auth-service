import { z } from "zod";
import {
  assignDefaultPlanIfNeeded,
  setUserSubscription,
} from "../../services/subscriptions.js";
import type { SubscriptionChangeSource } from "../../services/subscriptions.js";
import { syncStripeSubscription } from "../../services/billing/subscriptions.js";

/**
 * Shared shape of the audit-reason field used by every admin plan write, so the
 * bound and trimming cannot drift between the grant, bulk and update schemas.
 */
export const subscriptionReasonSchema = z.string().trim().min(1).max(500);

/** True when a payload carries a reason for a manual plan write. */
export function planChangeReasonRequired(input: {
  subscriptionPlanId?: unknown;
  expiresAt?: unknown;
  reason?: string;
}): boolean {
  const writesPlan =
    input.subscriptionPlanId !== undefined || input.expiresAt !== undefined;
  return writesPlan && input.reason === undefined;
}

export interface AssignRequestedOrDefaultPlanInput {
  userId: string;
  applicationId: string;
  /** Explicit plan, or omitted/`null` to fall back to the app default. */
  planId?: string | null;
  source?: SubscriptionChangeSource;
  actorUserId: string | null;
  reason?: string | null;
}

/**
 * Assigns the requested plan, or the application's default plan when none is
 * given. Shared by the single- and bulk-grant handlers so their plan resolution
 * and audit behaviour cannot drift apart.
 */
export async function assignRequestedOrDefaultPlan(
  input: AssignRequestedOrDefaultPlanInput,
): Promise<void> {
  if (input.planId) {
    await setUserSubscription({
      userId: input.userId,
      applicationId: input.applicationId,
      planId: input.planId,
      source: input.source ?? "admin",
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
    });
    await syncStripeSubscription({
      userId: input.userId,
      applicationId: input.applicationId,
      planId: input.planId,
    });
    return;
  }
  await assignDefaultPlanIfNeeded(input.userId, input.applicationId);
}
