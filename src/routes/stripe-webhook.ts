import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { stripe } from "../services/stripe.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  userSubscriptions,
  subscriptionPlanPrices,
  subscriptionPlans,
  stripeEvents,
  userApplications,
} from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";

/**
 * Maps a Stripe subscription status to our internal isActive flag.
 */
function stripeStatusToActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Resolve our internal planId from a Stripe price ID.
 * Returns null if no matching plan price is found.
 */
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

/**
 * Resolve our internal planId from a Stripe product ID.
 * Returns null if no matching subscription plan is found.
 */
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

/**
 * Extract the first price ID from a Stripe subscription's items.
 * `current_period_end` lives on SubscriptionItem in the new API version.
 */
function firstSubscriptionItem(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem | null {
  return subscription.items?.data?.[0] ?? null;
}

/**
 * Resolve planId from a subscription — tries price first, then product.
 */
async function resolvePlanIdFromSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const item = firstSubscriptionItem(subscription);
  if (!item) return null;

  const priceId = item.price?.id;
  if (priceId) {
    const planId = await planIdFromStripePriceId(priceId);
    if (planId) return planId;
  }

  // Fall back to product ID
  const product = item.price?.product;
  if (product) {
    const productId = typeof product === "string" ? product : product.id;
    return planIdFromStripeProductId(productId);
  }

  return null;
}

/**
 * Extract price ID from an invoice line item.
 * In the Stripe dahlia API version (2026-05-27.dahlia), the price is nested under
 * `pricing.price_details.price` rather than a top-level `price` field.
 */
function priceIdFromLineItem(lineItem: Stripe.InvoiceLineItem): string | null {
  const pricing = lineItem.pricing;
  if (!pricing) return null;
  const priceDetails = pricing.price_details;
  if (!priceDetails) return null;
  const price = priceDetails.price;
  if (!price) return null;
  if (typeof price === "string") return price;
  return price.id ?? null;
}

/** Resolve the application a plan belongs to (null if unknown). */
const planApplicationCache = new Map<
  string,
  { applicationId: string | null; expiresAt: number }
>();
const PLAN_APP_CACHE_TTL_MS = 5 * 60_000;

async function applicationIdFromPlanId(planId: string): Promise<string | null> {
  const cached = planApplicationCache.get(planId);
  if (cached && cached.expiresAt > Date.now()) return cached.applicationId;

  const [plan] = await db
    .select({ applicationId: subscriptionPlans.applicationId })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);
  const applicationId = plan?.applicationId ?? null;
  planApplicationCache.set(planId, {
    applicationId,
    expiresAt: Date.now() + PLAN_APP_CACHE_TTL_MS,
  });
  return applicationId;
}

/**
 * Handle customer.subscription.created / customer.subscription.updated
 */
async function handleSubscriptionUpsert(
  subscription: Stripe.Subscription,
  fastify: FastifyInstance,
): Promise<void> {
  const planId = await resolvePlanIdFromSubscription(subscription);
  if (!planId) {
    fastify.log.warn(
      { subscriptionId: subscription.id },
      "stripe-webhook: could not resolve planId for subscription",
    );
    return;
  }

  const isActive = stripeStatusToActive(subscription.status);

  // current_period_end is on the SubscriptionItem in the new Stripe API version
  const item = firstSubscriptionItem(subscription);
  const currentPeriodEnd =
    typeof item?.current_period_end === "number"
      ? new Date(item.current_period_end * 1000)
      : null;

  // The Stripe subscription metadata should carry userId
  const userId = (subscription.metadata?.userId as string | undefined) ?? null;
  if (!userId) {
    fastify.log.warn(
      { subscriptionId: subscription.id },
      "stripe-webhook: subscription has no userId in metadata — skipping",
    );
    return;
  }

  const applicationId = await applicationIdFromPlanId(planId);
  if (!applicationId) {
    fastify.log.warn(
      { subscriptionId: subscription.id, planId },
      "stripe-webhook: plan has no application — skipping",
    );
    return;
  }

  // A user has at most one subscription per application (unique index on
  // user_id + application_id). Upsert on that pair so a plan change updates the
  // existing row instead of violating the constraint.
  await db
    .insert(userSubscriptions)
    .values({
      userId,
      applicationId,
      planId,
      isActive,
      expiresAt: currentPeriodEnd,
    })
    .onConflictDoUpdate({
      target: [userSubscriptions.userId, userSubscriptions.applicationId],
      set: {
        planId,
        isActive,
        expiresAt: currentPeriodEnd,
        updatedAt: new Date(),
      },
    });

  // Mirror the plan onto the user's access row, which the admin UI reads.
  // Clear it when the subscription is not active so a canceled/past-due
  // subscription is not displayed as a live plan.
  await db
    .update(userApplications)
    .set({ subscriptionPlanId: isActive ? planId : null })
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, applicationId),
      ),
    );
}

/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  fastify: FastifyInstance,
): Promise<void> {
  const planId = await resolvePlanIdFromSubscription(subscription);
  if (!planId) {
    fastify.log.warn(
      { subscriptionId: subscription.id },
      "stripe-webhook: could not resolve planId for deleted subscription",
    );
    return;
  }

  const userId = (subscription.metadata?.userId as string | undefined) ?? null;
  if (!userId) {
    fastify.log.warn(
      { subscriptionId: subscription.id },
      "stripe-webhook: deleted subscription has no userId in metadata — skipping",
    );
    return;
  }

  const applicationId = await applicationIdFromPlanId(planId);
  if (!applicationId) return;

  await db
    .update(userSubscriptions)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
        // Ignore a deletion event for a plan the user has already left.
        eq(userSubscriptions.planId, planId),
      ),
    );

  // The plan is no longer active: clear the admin-UI mirror.
  await db
    .update(userApplications)
    .set({ subscriptionPlanId: null })
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, applicationId),
      ),
    );
}

/**
 * Handle invoice.payment_succeeded
 */
async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice,
  fastify: FastifyInstance,
): Promise<void> {
  const firstLine = invoice.lines?.data?.[0];
  if (!firstLine) return;

  const priceId = priceIdFromLineItem(firstLine);
  if (!priceId) return;

  const planId = await planIdFromStripePriceId(priceId);
  if (!planId) {
    fastify.log.warn(
      { invoiceId: invoice.id },
      "stripe-webhook: could not resolve planId for invoice",
    );
    return;
  }

  const userId = (invoice.metadata?.userId as string | undefined) ?? null;
  if (!userId) {
    fastify.log.warn(
      { invoiceId: invoice.id },
      "stripe-webhook: invoice has no userId in metadata — skipping",
    );
    return;
  }

  // period_end from the invoice line item
  const periodEnd = firstLine.period?.end;
  const expiresAt =
    typeof periodEnd === "number" ? new Date(periodEnd * 1000) : null;

  const applicationId = await applicationIdFromPlanId(planId);
  if (!applicationId) return;

  await db
    .update(userSubscriptions)
    .set({ isActive: true, expiresAt, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
        // Only reactivate the plan this invoice belongs to.
        eq(userSubscriptions.planId, planId),
      ),
    );
}

/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  fastify: FastifyInstance,
): Promise<void> {
  const firstLine = invoice.lines?.data?.[0];
  if (!firstLine) return;

  const priceId = priceIdFromLineItem(firstLine);
  if (!priceId) return;

  const planId = await planIdFromStripePriceId(priceId);
  if (!planId) {
    fastify.log.warn(
      { invoiceId: invoice.id },
      "stripe-webhook: could not resolve planId for failed invoice",
    );
    return;
  }

  const userId = (invoice.metadata?.userId as string | undefined) ?? null;
  if (!userId) {
    fastify.log.warn(
      { invoiceId: invoice.id },
      "stripe-webhook: failed invoice has no userId in metadata — skipping",
    );
    return;
  }

  const applicationId = await applicationIdFromPlanId(planId);
  if (!applicationId) return;

  await db
    .update(userSubscriptions)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, applicationId),
        // Only deactivate the plan this failed invoice belongs to.
        eq(userSubscriptions.planId, planId),
      ),
    );
}

export async function stripeWebhookRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Parse the body as a raw Buffer so Stripe can verify the signature.
  // This content-type parser is scoped to this plugin only.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Purge idempotency rows older than Stripe's retry window so the ledger
  // stays bounded. Runs periodically; unref'd so it never keeps the process
  // alive, and cleared on shutdown.
  const purgeInterval = setInterval(
    () => {
      void db
        .delete(stripeEvents)
        .where(sql`${stripeEvents.processedAt} < now() - interval '30 days'`)
        .catch((err: unknown) => {
          fastify.log.warn(
            { err },
            "stripe-webhook: failed to purge stripe_events",
          );
        });
    },
    6 * 60 * 60 * 1000,
  );
  purgeInterval.unref?.();
  fastify.addHook("onClose", async () => {
    clearInterval(purgeInterval);
  });

  // POST /api/webhooks/stripe
  fastify.post("/", async (req, reply) => {
    // Return 503 if Stripe is not configured
    if (!stripe || !config.stripe.webhookSecret) {
      return reply.status(503).send({
        error: { code: "SRV_002", message: "Stripe is not configured" },
      });
    }

    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      return reply.status(400).send({
        error: {
          code: "APP_001",
          message: "Missing stripe-signature header",
        },
      });
    }

    let event: Stripe.Event;
    try {
      // req.body is a Buffer because of the addContentTypeParser above
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        config.stripe.webhookSecret,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Signature verification failed";
      fastify.log.warn(
        { err },
        "stripe-webhook: signature verification failed",
      );
      return reply.status(400).send({ error: { code: "APP_001", message } });
    }

    fastify.log.info({ type: event.type }, "stripe-webhook: received event");

    // Idempotency: claim the event id before handling. A duplicate delivery
    // (Stripe retries at-least-once) finds the row already present and is
    // acknowledged without re-applying state.
    const claimed = await db
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (claimed.length === 0) {
      fastify.log.info(
        { eventId: event.id },
        "stripe-webhook: duplicate event ignored",
      );
      return reply.send({ received: true });
    }

    try {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
          await handleSubscriptionUpsert(
            event.data.object as Stripe.Subscription,
            fastify,
          );
          break;

        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(
            event.data.object as Stripe.Subscription,
            fastify,
          );
          break;

        case "invoice.payment_succeeded":
          await handleInvoicePaymentSucceeded(
            event.data.object as Stripe.Invoice,
            fastify,
          );
          break;

        case "invoice.payment_failed":
          await handleInvoicePaymentFailed(
            event.data.object as Stripe.Invoice,
            fastify,
          );
          break;

        default:
          fastify.log.debug(
            { type: event.type },
            "stripe-webhook: unhandled event type",
          );
      }
    } catch (err) {
      fastify.log.error(
        { err, type: event.type },
        "stripe-webhook: handler error",
      );
      // Release the idempotency claim so Stripe's retry is processed.
      await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
      return reply.status(500).send({
        error: { code: "SRV_001", message: "Internal server error" },
      });
    }

    return reply.send({ received: true });
  });
}
