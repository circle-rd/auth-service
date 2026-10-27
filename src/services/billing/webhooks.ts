import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import { setUserSubscription } from "../subscriptions.js";

/**
 * Stripe webhook handlers that maintain a user's subscription entitlement.
 *
 * Signature verification and idempotency stay in the route; every state change
 * goes through `setUserSubscription` so the canonical row, the admin mirror and
 * the audit trail can never drift.
 */

/** Minimal logger the route adapts from `fastify.log`. */
export interface WebhookLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

const ACTIVE_STATUSES: readonly string[] = ["active", "trialing"];

/** Entitlement state derived from a Stripe subscription status. */
export function stripeStatusToActive(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function toDate(unix: number | null | undefined): Date | null {
  return typeof unix === "number" ? new Date(unix * 1000) : null;
}

/**
 * Current-period bounds live on the subscription item in the dahlia API
 * version, not on the subscription itself.
 */
function primaryItem(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem | null {
  return subscription.items?.data?.[0] ?? null;
}

async function planIdFromStripePriceId(
  stripePriceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ planId: subscriptionPlanPrices.planId })
    .from(subscriptionPlanPrices)
    .where(eq(subscriptionPlanPrices.stripePriceId, stripePriceId))
    .limit(1);
  return row?.planId ?? null;
}

async function planIdFromStripeProductId(
  stripeProductId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.stripeProductId, stripeProductId))
    .limit(1);
  return row?.id ?? null;
}

async function applicationIdFromPlanId(planId: string): Promise<string | null> {
  const [row] = await db
    .select({ applicationId: subscriptionPlans.applicationId })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);
  return row?.applicationId ?? null;
}

/** Resolve a plan from the subscription's price, falling back to its product. */
async function planIdFromSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const item = primaryItem(subscription);
  const priceId = item?.price?.id;
  if (priceId) {
    const planId = await planIdFromStripePriceId(priceId);
    if (planId) return planId;
  }
  const product = item?.price?.product;
  if (product) {
    const productId = typeof product === "string" ? product : product.id;
    return planIdFromStripeProductId(productId);
  }
  return null;
}

interface SubscriptionTarget {
  userId: string;
  applicationId: string;
  planId: string;
}

async function findSubscriptionTarget(
  stripeSubscriptionId: string,
): Promise<SubscriptionTarget | null> {
  const [row] = await db
    .select({
      userId: userSubscriptions.userId,
      applicationId: userSubscriptions.applicationId,
      planId: userSubscriptions.planId,
    })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the (user, application, plan) a Stripe subscription belongs to. The
 * stored `stripe_subscription_id` is authoritative; when the row is not known
 * yet (the very first event) we fall back to the plan resolved from the price
 * and the `userId` carried in the subscription metadata.
 */
async function resolveSubscriptionTarget(
  subscription: Stripe.Subscription,
  log: WebhookLog,
): Promise<SubscriptionTarget | null> {
  const existing = await findSubscriptionTarget(subscription.id);
  const planId =
    existing?.planId ?? (await planIdFromSubscription(subscription));
  if (!planId) {
    log.warn(
      { subscriptionId: subscription.id },
      "billing: could not resolve a plan for this subscription",
    );
    return null;
  }

  const userId =
    existing?.userId ??
    (subscription.metadata?.userId as string | undefined) ??
    null;
  if (!userId) {
    log.warn(
      { subscriptionId: subscription.id },
      "billing: subscription carries no user id",
    );
    return null;
  }

  const applicationId =
    existing?.applicationId ?? (await applicationIdFromPlanId(planId));
  if (!applicationId) {
    log.warn(
      { subscriptionId: subscription.id, planId },
      "billing: plan is not attached to an application",
    );
    return null;
  }

  return { userId, applicationId, planId };
}

/** Apply the full Stripe state of a subscription (created / updated). */
export async function syncSubscription(
  subscription: Stripe.Subscription,
  log: WebhookLog,
): Promise<void> {
  const target = await resolveSubscriptionTarget(subscription, log);
  if (!target) return;

  const item = primaryItem(subscription);
  const currentPeriodStart = toDate(item?.current_period_start);
  const currentPeriodEnd = toDate(item?.current_period_end);

  await setUserSubscription({
    userId: target.userId,
    applicationId: target.applicationId,
    planId: target.planId,
    source: "stripe",
    isActive: stripeStatusToActive(subscription.status),
    expiresAt: currentPeriodEnd,
    stripe: {
      stripeSubscriptionId: subscription.id,
      stripeStatus: subscription.status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      canceledAt: toDate(subscription.canceled_at),
    },
  });
}

/**
 * A subscription ended. The row is kept (inactive) rather than deleted so the
 * status and the cancellation date stay visible and the entitlement claim drops
 * it; the admin mirror is cleared by the canonical write path.
 */
export async function cancelSubscription(
  subscription: Stripe.Subscription,
  log: WebhookLog,
): Promise<void> {
  const target = await resolveSubscriptionTarget(subscription, log);
  if (!target) return;

  const item = primaryItem(subscription);
  const currentPeriodEnd = toDate(item?.current_period_end);

  await setUserSubscription({
    userId: target.userId,
    applicationId: target.applicationId,
    planId: target.planId,
    source: "stripe",
    isActive: false,
    expiresAt: currentPeriodEnd,
    stripe: {
      stripeSubscriptionId: subscription.id,
      stripeStatus: subscription.status ?? "canceled",
      currentPeriodStart: toDate(item?.current_period_start),
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: toDate(subscription.canceled_at) ?? new Date(),
    },
  });
}

function priceIdFromLineItem(lineItem: Stripe.InvoiceLineItem): string | null {
  const price = lineItem.pricing?.price_details?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

export function subscriptionIdFromInvoice(
  invoice: Stripe.Invoice,
): string | null {
  const ref = invoice.parent?.subscription_details?.subscription;
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

interface InvoiceTarget {
  target: SubscriptionTarget;
  stripeSubscriptionId: string | null;
}

async function resolveInvoiceTarget(
  invoice: Stripe.Invoice,
  log: WebhookLog,
): Promise<InvoiceTarget | null> {
  const stripeSubscriptionId = subscriptionIdFromInvoice(invoice);
  if (stripeSubscriptionId) {
    const existing = await findSubscriptionTarget(stripeSubscriptionId);
    if (existing) return { target: existing, stripeSubscriptionId };
  }

  const metadata = invoice.parent?.subscription_details?.metadata;
  const userId =
    (metadata?.userId as string | undefined) ??
    (invoice.metadata?.userId as string | undefined) ??
    null;
  const line = invoice.lines?.data?.[0];
  const priceId = line ? priceIdFromLineItem(line) : null;
  const planId = priceId ? await planIdFromStripePriceId(priceId) : null;
  if (!userId || !planId) {
    log.warn(
      { invoiceId: invoice.id },
      "billing: could not resolve the invoice owner",
    );
    return null;
  }

  const applicationId = await applicationIdFromPlanId(planId);
  if (!applicationId) return null;
  return { target: { userId, applicationId, planId }, stripeSubscriptionId };
}

/** Billing reasons whose failure is a real dunning event for the subscription. */
const DUNNING_REASONS: readonly string[] = [
  "subscription_create",
  "subscription_cycle",
];

async function applyInvoicePayment(
  invoice: Stripe.Invoice,
  paid: boolean,
  log: WebhookLog,
): Promise<void> {
  // Only subscription invoices move a subscription; a one-off invoice has no
  // `subscription_details` parent and is ignored here.
  if (!invoice.parent?.subscription_details) return;
  if (
    !paid &&
    (invoice.billing_reason === null ||
      !DUNNING_REASONS.includes(invoice.billing_reason))
  ) {
    // A failed proration or manual invoice does not mean the subscription lapsed.
    return;
  }

  const resolved = await resolveInvoiceTarget(invoice, log);
  if (!resolved) return;
  const { target, stripeSubscriptionId } = resolved;

  if (paid) {
    await setUserSubscription({
      userId: target.userId,
      applicationId: target.applicationId,
      planId: target.planId,
      source: "stripe",
      isActive: true,
      expiresAt: toDate(invoice.period_end),
      stripe: {
        ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
        currentPeriodStart: toDate(invoice.period_start),
        currentPeriodEnd: toDate(invoice.period_end),
      },
    });
    return;
  }

  await setUserSubscription({
    userId: target.userId,
    applicationId: target.applicationId,
    planId: target.planId,
    source: "stripe",
    isActive: false,
    stripe: stripeSubscriptionId ? { stripeSubscriptionId } : undefined,
  });
}

export async function applyInvoicePaid(
  invoice: Stripe.Invoice,
  log: WebhookLog,
): Promise<void> {
  await applyInvoicePayment(invoice, true, log);
}

export async function applyInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  log: WebhookLog,
): Promise<void> {
  await applyInvoicePayment(invoice, false, log);
}
