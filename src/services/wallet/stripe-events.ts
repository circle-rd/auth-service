import type Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { walletTransactions } from "../../db/schema.js";
import { getOrCreateWalletAccount } from "./accounts.js";
import { creditWallet, debitWallet } from "./ledger.js";

const topupMetadataSchema = z.object({
  purpose: z.literal("wallet_topup"),
  userId: z.string().min(1),
  creditMicro: z.string().regex(/^[1-9][0-9]{0,18}$/),
});

function idOf(
  ref: string | { id: string } | null | undefined,
): string | undefined {
  return typeof ref === "string" ? ref : ref?.id;
}

/** Credit the wallet once the payment is confirmed (replay-safe per session). */
async function creditPaidCheckout(
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  if (session.metadata?.purpose !== "wallet_topup") return false;
  // An asynchronous payment method confirms later through its own event.
  if (session.payment_status !== "paid") return true;

  const meta = topupMetadataSchema.parse(session.metadata);
  const account = await getOrCreateWalletAccount("user", meta.userId);
  await creditWallet({
    accountId: account.id,
    type: "topup",
    amount: BigInt(meta.creditMicro),
    idempotencyKey: `stripe:checkout:${session.id}`,
    metadata: {
      source: "stripe",
      sessionId: session.id,
      paymentIntentId: idOf(session.payment_intent) ?? null,
      chargedCurrency: session.currency,
      chargedAmount: session.amount_total,
    },
  });
  return true;
}

/**
 * Take back part of a Stripe top-up. The credit may already be spent, so the
 * reversal is allowed to leave the wallet in debt, repaid by the next top-up.
 * Serialised per payment intent so two concurrent events cannot both reverse
 * the same share; the reversed total never exceeds what was credited.
 */
async function reverseTopup(opts: {
  paymentIntentId: string;
  idempotencyKey: string;
  chargeId: string | null;
  reason: "refund" | "dispute";
  /** Share of the credited amount to take back, given the credited amount. */
  target: (credited: bigint) => bigint;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`wallet-stripe:${opts.paymentIntentId}`}))`,
    );
    const ofPaymentIntent = sql`${walletTransactions.metadata}->>'paymentIntentId' = ${opts.paymentIntentId}`;

    const [topup] = await tx
      .select({
        accountId: walletTransactions.accountId,
        amount: walletTransactions.amount,
      })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.type, "topup"), ofPaymentIntent))
      .limit(1);
    // A payment that did not buy credit (e.g. a subscription): not ours.
    if (!topup) return false;

    const [reversed] = await tx
      .select({
        total: sql<string>`coalesce(sum(-${walletTransactions.amount}), 0)`,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.accountId, topup.accountId),
          eq(walletTransactions.type, "reversal"),
          ofPaymentIntent,
        ),
      );
    const target = opts.target(topup.amount);
    const capped = target > topup.amount ? topup.amount : target;
    const delta = capped - BigInt(reversed?.total ?? "0");
    if (delta <= 0n) return true;

    await debitWallet({
      accountId: topup.accountId,
      type: "reversal",
      amount: delta,
      idempotencyKey: opts.idempotencyKey,
      metadata: {
        source: "stripe",
        reason: opts.reason,
        paymentIntentId: opts.paymentIntentId,
        chargeId: opts.chargeId,
      },
    });
    return true;
  });
}

async function reverseRefundedCharge(charge: Stripe.Charge): Promise<boolean> {
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId || charge.amount_captured <= 0) return false;
  return reverseTopup({
    paymentIntentId,
    // The refunded total grows with each partial refund: one key per level.
    idempotencyKey: `stripe:refund:${charge.id}:${charge.amount_refunded}`,
    chargeId: charge.id,
    reason: "refund",
    target: (credited) =>
      (credited * BigInt(charge.amount_refunded)) /
      BigInt(charge.amount_captured),
  });
}

async function reverseDisputedCharge(
  dispute: Stripe.Dispute,
): Promise<boolean> {
  const paymentIntentId = idOf(dispute.payment_intent);
  if (!paymentIntentId) return false;
  return reverseTopup({
    paymentIntentId,
    idempotencyKey: `stripe:dispute:${dispute.id}`,
    chargeId: idOf(dispute.charge) ?? null,
    reason: "dispute",
    target: (credited) => credited,
  });
}

/**
 * Apply the wallet side of a Stripe event. Returns false when the event is not
 * about the wallet, so the caller can fall back to its other handlers.
 */
export async function handleWalletStripeEvent(
  event: Stripe.Event,
): Promise<boolean> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return creditPaidCheckout(event.data.object);
    case "charge.refunded":
      return reverseRefundedCharge(event.data.object);
    case "charge.dispute.created":
      return reverseDisputedCharge(event.data.object);
    default:
      return false;
  }
}
