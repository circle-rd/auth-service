import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { stripe } from "../services/stripe.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { stripeEvents } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { handleWalletStripeEvent } from "../services/wallet/index.js";
import {
  applyInvoicePaid,
  applyInvoicePaymentFailed,
  cancelSubscription,
  completeSubscriptionCheckout,
  syncSubscription,
  type WebhookLog,
} from "../services/billing/webhooks.js";
import { cacheStripeInvoice } from "../services/billing/invoices.js";

export async function stripeWebhookRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const log: WebhookLog = {
    warn: (obj, msg) => fastify.log.warn(obj, msg),
    debug: (obj, msg) => fastify.log.debug(obj, msg),
  };

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
      fastify.log.warn(
        { err },
        "stripe-webhook: signature verification failed",
      );
      // Never echo the parser message: it is attacker-influenced and adds no
      // value to the caller, who only needs to know the signature was refused.
      return reply.status(400).send({
        error: {
          code: "APP_001",
          message: "Invalid Stripe signature",
        },
      });
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
      // Every invoice event refreshes the read cache, whatever it does to the
      // entitlement below (a wallet top-up invoice has no subscription at all).
      if (event.type.startsWith("invoice.")) {
        await cacheStripeInvoice(
          event.data.object as Stripe.Invoice,
          event.created,
          log,
        );
      }

      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
          await syncSubscription(event.data.object as Stripe.Subscription, log);
          break;

        case "customer.subscription.deleted":
          await cancelSubscription(
            event.data.object as Stripe.Subscription,
            log,
          );
          break;

        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode === "subscription") {
            await completeSubscriptionCheckout(session, log);
          } else {
            await handleWalletStripeEvent(event);
          }
          break;
        }

        case "invoice.paid":
        case "invoice.payment_succeeded":
          await applyInvoicePaid(event.data.object as Stripe.Invoice, log);
          break;

        case "invoice.payment_failed":
          await applyInvoicePaymentFailed(
            event.data.object as Stripe.Invoice,
            log,
          );
          break;

        default: {
          // Wallet top-ups, refunds and disputes live in the wallet service.
          const handled = await handleWalletStripeEvent(event);
          if (!handled) {
            log.debug(
              { type: event.type },
              "stripe-webhook: unhandled event type",
            );
          }
        }
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
