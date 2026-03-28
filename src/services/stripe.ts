import Stripe from "stripe";
import { config } from "../config.js";

/**
 * Returns a configured Stripe client if STRIPE_SECRET_KEY is set, null otherwise.
 * All callers must check for null before using the client.
 */
function createStripeClient(): Stripe | null {
  if (!config.stripe.secretKey) return null;
  return new Stripe(config.stripe.secretKey, {
    apiVersion: "2026-03-25.dahlia",
    typescript: true,
  });
}

export const stripe = createStripeClient();

export function isStripeConfigured(): boolean {
  return stripe !== null;
}
