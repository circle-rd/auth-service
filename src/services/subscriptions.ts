import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  subscriptionPlans,
  userApplications,
  userSubscriptionEvents,
  userSubscriptions,
} from "../db/schema.js";
import { ERR } from "../errors.js";
import { publishEvent } from "./event-bus.js";
import { syncStripeSubscription } from "./billing/subscriptions.js";

/**
 * Single write path for a user's subscription.
 *
 * `user_subscriptions` is canonical (it is what the OIDC feature claims read);
 * `user_applications.subscription_plan_id` is a denormalised mirror kept in
 * sync here so the admin and user listings can read it without a join. Every
 * caller — admin endpoints, default-plan assignment, the self-service route and
 * the Stripe webhook — goes through this module so the two never drift.
 */

/** Who initiated the change; recorded on every audit entry. */
export type SubscriptionChangeSource = "admin" | "self" | "default" | "stripe";

export type SubscriptionAction = "assigned" | "changed" | "removed";

/**
 * Stripe state to persist alongside a subscription. Every field is optional so
 * an event that only knows part of the state (an invoice, say) never clears a
 * field it did not read: `undefined` leaves the column untouched, while `null`
 * clears it.
 */
export interface StripeSubscriptionState {
  stripeSubscriptionId?: string;
  stripeStatus?: string | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date | null;
}

export interface SetUserSubscriptionInput {
  userId: string;
  applicationId: string;
  /** Target plan, or `null` to remove the subscription. */
  planId: string | null;
  source: SubscriptionChangeSource;
  /** Acting user; `null`/omitted for automatic paths (`default`, `stripe`). */
  actorUserId?: string | null;
  reason?: string | null;
  /** Optional expiry. Left untouched on a change when omitted. */
  expiresAt?: Date | null;
  /** Entitlement state when a plan is set; defaults to active. */
  isActive?: boolean;
  /** Stripe linkage; present only for `source: "stripe"`. */
  stripe?: StripeSubscriptionState;
}

export interface SubscriptionChange {
  planId: string | null;
  /** False when the call left the persisted subscription unchanged. */
  changed: boolean;
  action: SubscriptionAction | null;
  fromPlanId: string | null;
  toPlanId: string | null;
}

interface CurrentSubscription {
  planId: string | null;
  isActive: boolean;
  expiresAt: Date | null;
}

/**
 * Throws `SUB_001` when the plan does not belong to the application. Exported
 * so a route can validate before it mutates anything else in the same request.
 */
export async function assertPlanBelongsToApp(
  planId: string,
  applicationId: string,
): Promise<void> {
  const [plan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.id, planId),
        eq(subscriptionPlans.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!plan) throw ERR.SUB_001();
}

async function readCurrentSubscription(
  userId: string,
  applicationId: string,
): Promise<CurrentSubscription | null> {
  const [row] = await db
    .select({
      planId: userSubscriptions.planId,
      isActive: userSubscriptions.isActive,
      expiresAt: userSubscriptions.expiresAt,
    })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Current canonical plan id for a user/application, or `null` when the user
 * holds no subscription. Lets an expiry-only update keep the current plan
 * without re-stating it.
 */
export async function getCurrentSubscriptionPlanId(
  userId: string,
  applicationId: string,
): Promise<string | null> {
  const current = await readCurrentSubscription(userId, applicationId);
  return current?.planId ?? null;
}

function sameInstant(
  a: Date | null | undefined,
  b: Date | null | undefined,
): boolean {
  return (a ? a.getTime() : null) === (b ? b.getTime() : null);
}

type SubscriptionColumns = Partial<typeof userSubscriptions.$inferInsert>;

/** Only the Stripe columns the caller actually supplied (see the input docs). */
function stripeColumns(
  stripe: StripeSubscriptionState | undefined,
): SubscriptionColumns {
  if (!stripe) return {};
  const out: SubscriptionColumns = {};
  if (stripe.stripeSubscriptionId !== undefined) {
    out.stripeSubscriptionId = stripe.stripeSubscriptionId;
  }
  if (stripe.stripeStatus !== undefined) out.stripeStatus = stripe.stripeStatus;
  if (stripe.currentPeriodStart !== undefined) {
    out.currentPeriodStart = stripe.currentPeriodStart;
  }
  if (stripe.currentPeriodEnd !== undefined) {
    out.currentPeriodEnd = stripe.currentPeriodEnd;
  }
  if (stripe.cancelAtPeriodEnd !== undefined) {
    out.cancelAtPeriodEnd = stripe.cancelAtPeriodEnd;
  }
  if (stripe.canceledAt !== undefined) out.canceledAt = stripe.canceledAt;
  return out;
}

/**
 * Persist a subscription change on an already-validated plan.
 *
 * A change that only differs in `expiresAt`, or that flips the entitlement
 * state (reactivation after a `past_due`, deactivation after a cancellation),
 * is an effective change: it is audited and announced even when the plan id
 * itself is unchanged.
 */
async function applySubscriptionChange(
  current: CurrentSubscription | null,
  input: SetUserSubscriptionInput,
): Promise<SubscriptionChange> {
  const { userId, applicationId, planId } = input;
  const isActive = input.isActive ?? true;

  const fromPlanId = current?.planId ?? null;
  const expiryChanged =
    input.expiresAt !== undefined &&
    !sameInstant(input.expiresAt, current?.expiresAt);
  const statusChanged =
    planId !== null && current !== null && current.isActive !== isActive;
  const changed = fromPlanId !== planId || expiryChanged || statusChanged;

  const action: SubscriptionAction | null = !changed
    ? null
    : fromPlanId === null
      ? "assigned"
      : planId === null
        ? "removed"
        : "changed";

  await db.transaction(async (tx) => {
    if (planId === null) {
      await tx
        .delete(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, userId),
            eq(userSubscriptions.applicationId, applicationId),
          ),
        );
    } else {
      const stripe = stripeColumns(input.stripe);
      await tx
        .insert(userSubscriptions)
        .values({
          userId,
          applicationId,
          planId,
          isActive,
          expiresAt: input.expiresAt ?? null,
          ...stripe,
        })
        .onConflictDoUpdate({
          target: [userSubscriptions.userId, userSubscriptions.applicationId],
          set: {
            planId,
            isActive,
            updatedAt: new Date(),
            ...(input.expiresAt !== undefined
              ? { expiresAt: input.expiresAt }
              : {}),
            ...stripe,
          },
        });
    }

    // The mirror is the "live plan" the admin UI reads: an inactive
    // subscription must not be displayed as the user's current plan.
    await tx
      .update(userApplications)
      .set({ subscriptionPlanId: isActive && planId !== null ? planId : null })
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.applicationId, applicationId),
        ),
      );

    if (changed && action) {
      await tx.insert(userSubscriptionEvents).values({
        userId,
        applicationId,
        actorUserId: input.actorUserId ?? null,
        source: input.source,
        action,
        fromPlanId,
        toPlanId: planId,
        reason: input.reason ?? null,
      });
    }
  });

  if (changed && input.source !== "default") notifySubscriptionChanged();

  return { planId, changed, action, fromPlanId, toPlanId: planId };
}

/**
 * Assign, change or remove a user's plan for one application, then write the
 * audit entry and notify the live dashboards.
 */
export async function setUserSubscription(
  input: SetUserSubscriptionInput,
): Promise<SubscriptionChange> {
  if (input.planId !== null) {
    await assertPlanBelongsToApp(input.planId, input.applicationId);
  }
  const current = await readCurrentSubscription(
    input.userId,
    input.applicationId,
  );
  return applySubscriptionChange(current, input);
}

/**
 * Assigns the application's default subscription plan to a user that has none
 * for that application. A no-op when the app has no default plan or the user
 * already holds a subscription (active or not).
 */
export async function assignDefaultPlanIfNeeded(
  userId: string,
  applicationId: string,
): Promise<void> {
  const [defaultPlan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.applicationId, applicationId),
        eq(subscriptionPlans.isDefault, true),
      ),
    )
    .limit(1);

  if (!defaultPlan) return;

  const current = await readCurrentSubscription(userId, applicationId);
  if (current) return;

  // The plan was read from this application's default, so it is already valid.
  await applySubscriptionChange(current, {
    userId,
    applicationId,
    planId: defaultPlan.id,
    source: "default",
  });
  // Every plan, the free one included, is backed by a Stripe subscription.
  await syncStripeSubscription({
    userId,
    applicationId,
    planId: defaultPlan.id,
  });
}

// ── Live notification ──────────────────────────────────────────────────────

/** Shortest delay between two `subscription.changed` events. */
const MIN_NOTIFY_INTERVAL_MS = 1_000;

let lastNotifiedAt = 0;
let pendingNotify: NodeJS.Timeout | null = null;

function emitSubscriptionChanged(): void {
  lastNotifiedAt = Date.now();
  publishEvent("subscription.changed");
}

/**
 * Tell the admin dashboard that a subscription changed. A bulk grant can
 * produce hundreds of changes in one request, so events are coalesced: the
 * first goes out at once, the rest within the next second collapse into a
 * single trailing one. The channel is a signal, so one frame per burst is
 * enough — clients re-read the authoritative state.
 */
export function notifySubscriptionChanged(): void {
  const elapsed = Date.now() - lastNotifiedAt;
  if (elapsed >= MIN_NOTIFY_INTERVAL_MS) {
    emitSubscriptionChanged();
    return;
  }
  if (pendingNotify) return;
  pendingNotify = setTimeout(() => {
    pendingNotify = null;
    emitSubscriptionChanged();
  }, MIN_NOTIFY_INTERVAL_MS - elapsed);
  pendingNotify.unref();
}
