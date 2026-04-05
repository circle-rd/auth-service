import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { stripe } from "../services/stripe.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  userSubscriptions,
  subscriptionPlanPrices,
  subscriptionPlans,
} from "../db/schema.js";
import { eq, and } from "drizzle-orm";

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
 * In the new Stripe API version (2026-03-25.dahlia), the price is nested under
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

  // Upsert: update existing subscription for this user+plan, or insert
  const [existing] = await db
    .select({ id: userSubscriptions.id })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.planId, planId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(userSubscriptions)
      .set({
        isActive,
        expiresAt: currentPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.id, existing.id));
  } else {
    // Find applicationId from the plan
    const [plan] = await db
      .select({ applicationId: subscriptionPlans.applicationId })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1);

    if (!plan) return;

    await db.insert(userSubscriptions).values({
      userId,
      applicationId: plan.applicationId,
      planId,
      isActive,
      expiresAt: currentPeriodEnd,
    });
  }
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

  await db
    .update(userSubscriptions)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.planId, planId),
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

  await db
    .update(userSubscriptions)
    .set({ isActive: true, expiresAt, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, userId),
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

  await db
    .update(userSubscriptions)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(userSubscriptions.userId, userId),
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
      return reply.status(500).send({
        error: { code: "SRV_001", message: "Internal server error" },
      });
    }

    return reply.send({ received: true });
  });
}
