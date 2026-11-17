import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { walletAutoTopups } from "../../db/schema.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { stripe } from "../stripe.js";
import { getOrCreateWalletAccount } from "./accounts.js";
import {
  AUTO_TOPUP_SETUP_PURPOSE,
  activateAutoTopup,
  disableAutoTopupForPaymentMethod,
} from "./auto-topup.js";
import { triggerAutoTopup } from "./auto-topup-charge.js";
import { creditWallet } from "./ledger.js";

const setupMetadataSchema = z.object({
  purpose: z.literal(AUTO_TOPUP_SETUP_PURPOSE),
  userId: z.string().min(1),
  amountCents: z.coerce.number().int().positive(),
});

const invoiceMetadataSchema = z.object({
  purpose: z.literal("wallet_topup"),
  trigger: z.literal("auto"),
  userId: z.string().min(1),
  creditMicro: z.string().regex(/^[1-9][0-9]{0,18}$/),
});

function idOf(
  ref: string | { id: string } | null | undefined,
): string | undefined {
  return typeof ref === "string" ? ref : ref?.id;
}

/** A Checkout in setup mode saved a card: finish turning the option on. */
async function completeSetup(
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  if (session.metadata?.purpose !== AUTO_TOPUP_SETUP_PURPOSE) return false;
  if (!stripe) return true;

  const meta = setupMetadataSchema.parse(session.metadata);
  const setupIntentId = idOf(session.setup_intent);
  const setupIntent = setupIntentId
    ? await stripe.setupIntents.retrieve(setupIntentId)
    : null;
  const paymentMethodId = idOf(setupIntent?.payment_method);
  if (setupIntent?.status !== "succeeded" || !paymentMethodId) return true;

  // The bounds may have been tightened since the session was opened.
  if (
    meta.amountCents < config.wallet.minTopupCents ||
    meta.amountCents > config.wallet.maxTopupCents
  ) {
    logger.warn(
      { sessionId: session.id },
      "[wallet] auto top-up setup amount out of range; ignored",
    );
    return true;
  }

  const account = await getOrCreateWalletAccount("user", meta.userId);
  await activateAutoTopup({
    accountId: account.id,
    amountCents: meta.amountCents,
    paymentMethodId,
  });
  triggerAutoTopup(account.id);
  return true;
}

async function paymentIntentOfInvoice(invoiceId: string): Promise<string> {
  if (!stripe) throw new Error("Stripe is not configured");
  const payments = await stripe.invoicePayments.list({
    invoice: invoiceId,
    limit: 1,
  });
  const intent = payments.data[0]?.payment.payment_intent;
  const id = idOf(intent);
  if (!id) throw new Error(`Invoice ${invoiceId} has no payment intent`);
  return id;
}

/** Credit an automatic top-up once its invoice is paid (replay-safe per invoice). */
async function creditPaidInvoice(invoice: Stripe.Invoice): Promise<boolean> {
  if (invoice.metadata?.trigger !== "auto") return false;
  const meta = invoiceMetadataSchema.parse(invoice.metadata);

  const account = await getOrCreateWalletAccount("user", meta.userId);
  await creditWallet({
    accountId: account.id,
    type: "topup",
    amount: BigInt(meta.creditMicro),
    idempotencyKey: `stripe:invoice:${invoice.id}`,
    metadata: {
      source: "stripe",
      trigger: "auto",
      invoiceId: invoice.id,
      paymentIntentId: await paymentIntentOfInvoice(invoice.id),
      chargedCurrency: invoice.currency,
      chargedAmount: invoice.amount_paid,
    },
  });
  await db
    .update(walletAutoTopups)
    .set({ chargePending: false, updatedAt: new Date() })
    .where(eq(walletAutoTopups.accountId, account.id));
  return true;
}

/**
 * Apply the automatic top-up side of a Stripe event. Returns false when the
 * event is not about it, so the caller can fall back to its other handlers.
 */
export async function handleAutoTopupStripeEvent(
  event: Stripe.Event,
): Promise<boolean> {
  switch (event.type) {
    case "checkout.session.completed":
      return event.data.object.mode === "setup"
        ? completeSetup(event.data.object)
        : false;
    case "invoice.paid":
      return creditPaidInvoice(event.data.object);
    case "payment_method.detached":
      await disableAutoTopupForPaymentMethod(event.data.object.id);
      return true;
    default:
      return false;
  }
}
