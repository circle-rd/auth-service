import { config } from "../../config.js";
import { ERR } from "../../errors.js";
import { stripe } from "../stripe.js";

/** 1 euro cent in the ledger unit (micro-euros). */
export const CENTS_TO_MICRO = 10_000n;

export interface TopupOptions {
  enabled: boolean;
  currency: "eur";
  minCents: number;
  maxCents: number;
}

export function getTopupOptions(): TopupOptions {
  return {
    enabled: stripe !== null,
    currency: "eur",
    minCents: config.wallet.minTopupCents,
    maxCents: config.wallet.maxTopupCents,
  };
}

/**
 * Open a Stripe Checkout page to buy credit. The ledger stays in euros; the
 * customer's local currency is Stripe's job (Adaptive Pricing), and the credit
 * granted is the euro amount recorded in the session metadata, whatever
 * currency was charged.
 */
export async function createTopupCheckout(input: {
  userId: string;
  email: string | null;
  amountCents: number;
}): Promise<{ url: string }> {
  if (!stripe) throw ERR.WAL_006();

  const minCents = config.wallet.minTopupCents;
  const maxCents = config.wallet.maxTopupCents;
  if (input.amountCents < minCents || input.amountCents > maxCents) {
    throw ERR.WAL_004("Top-up amount out of range", { minCents, maxCents });
  }
  const creditMicro = BigInt(input.amountCents) * CENTS_TO_MICRO;
  const metadata = {
    purpose: "wallet_topup",
    userId: input.userId,
    creditMicro: creditMicro.toString(),
  };
  const returnUrl = `${config.betterAuth.url}/profile`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: input.userId,
    ...(input.email ? { customer_email: input.email } : {}),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: input.amountCents,
          product_data: { name: "Credits" },
        },
      },
    ],
    adaptive_pricing: { enabled: true },
    // A top-up is also a Stripe invoice (paid and receipted), cached for the
    // profile. The metadata links it back to the wallet owner.
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata: { purpose: "wallet_topup", userId: input.userId },
      },
    },
    metadata,
    payment_intent_data: { metadata },
    success_url: `${returnUrl}?topup=success`,
    cancel_url: `${returnUrl}?topup=cancelled`,
  });
  if (!session.url) throw ERR.SRV_001("Stripe returned no checkout URL");
  return { url: session.url };
}
