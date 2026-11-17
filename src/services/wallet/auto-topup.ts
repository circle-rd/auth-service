import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import {
  walletAccounts,
  walletAutoTopups,
  walletTransactions,
} from "../../db/schema.js";
import { config } from "../../config.js";
import { ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import { getOrCreateBillingCustomer } from "../billing/customers.js";
import { sendAutoTopupDisabledEmail } from "../email.js";
import { stripe } from "../stripe.js";
import { assertTopupAmount } from "./checkout.js";

/** Auto top-up fires when the balance is at or below one euro. */
export const AUTO_TOPUP_THRESHOLD_MICRO = 1_000_000n;

/** Shortest delay between two charge attempts on one account. */
export const AUTO_TOPUP_COOLDOWN_MS = 5 * 60_000;

export const AUTO_TOPUP_SETUP_PURPOSE = "wallet_auto_topup_setup";

export type AutoTopupDisabledReason =
  "payment_failed" | "authentication_required" | "payment_method_removed";

/** Reasons that make the saved card unusable: a new one must be registered. */
const CARD_FAILURES: readonly AutoTopupDisabledReason[] = [
  "payment_failed",
  "authentication_required",
];

export interface AutoTopupView {
  enabled: boolean;
  amountCents: number | null;
  /** When the last automatic top-up was credited. */
  lastTopupAt: string | null;
  /** Why the system turned the option off, until the user acts again. */
  disabledReason: AutoTopupDisabledReason | null;
}

export type EnableAutoTopupResult =
  { enabled: true } | { enabled: false; setupUrl: string };

const columns = {
  accountId: walletAutoTopups.accountId,
  enabled: walletAutoTopups.enabled,
  amountCents: walletAutoTopups.amountCents,
  stripePaymentMethodId: walletAutoTopups.stripePaymentMethodId,
  disabledReason: walletAutoTopups.disabledReason,
};

async function findRow(accountId: string) {
  const [row] = await db
    .select(columns)
    .from(walletAutoTopups)
    .where(eq(walletAutoTopups.accountId, accountId))
    .limit(1);
  return row;
}

function asReason(value: string | null): AutoTopupDisabledReason | null {
  return value === "payment_failed" ||
    value === "authentication_required" ||
    value === "payment_method_removed"
    ? value
    : null;
}

export async function getAutoTopupView(
  accountId: string,
): Promise<AutoTopupView> {
  const row = await findRow(accountId);
  const [last] = await db
    .select({ createdAt: walletTransactions.createdAt })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.accountId, accountId),
        eq(walletTransactions.type, "topup"),
        sql`${walletTransactions.metadata}->>'trigger' = 'auto'`,
      ),
    )
    .orderBy(desc(walletTransactions.createdAt))
    .limit(1);
  return {
    enabled: row?.enabled ?? false,
    amountCents: row?.amountCents ?? null,
    lastTopupAt: last?.createdAt.toISOString() ?? null,
    disabledReason: asReason(row?.disabledReason ?? null),
  };
}

/** Turn the option on with a usable payment method; a fresh consent. */
export async function activateAutoTopup(input: {
  accountId: string;
  amountCents: number;
  paymentMethodId: string;
}): Promise<void> {
  const values = {
    enabled: true,
    amountCents: input.amountCents,
    stripePaymentMethodId: input.paymentMethodId,
    disabledReason: null,
    lastAttemptAt: null,
    chargePending: false,
    updatedAt: new Date(),
  };
  await db
    .insert(walletAutoTopups)
    .values({ accountId: input.accountId, ...values })
    .onConflictDoUpdate({ target: walletAutoTopups.accountId, set: values });
}

/** The user turns the option off: the card reference is forgotten. */
export async function disableAutoTopup(accountId: string): Promise<void> {
  await db
    .update(walletAutoTopups)
    .set({
      enabled: false,
      stripePaymentMethodId: null,
      disabledReason: null,
      chargePending: false,
      updatedAt: new Date(),
    })
    .where(eq(walletAutoTopups.accountId, accountId));
}

async function notifyDisabled(
  accountId: string,
  amountCents: number,
  reason: AutoTopupDisabledReason,
): Promise<void> {
  const [owner] = await db
    .select({ email: user.email })
    .from(walletAccounts)
    .innerJoin(user, eq(user.id, walletAccounts.ownerId))
    .where(eq(walletAccounts.id, accountId))
    .limit(1);
  if (!owner) return;
  try {
    await sendAutoTopupDisabledEmail(owner.email, {
      reason,
      amount: new Intl.NumberFormat("en", {
        style: "currency",
        currency: "EUR",
      }).format(amountCents / 100),
      url: `${config.betterAuth.url}/profile`,
    });
  } catch (err) {
    logger.warn(
      { err: String(err), accountId },
      "[wallet] auto top-up e-mail failed",
    );
  }
}

/** The system turns the option off and tells the user why. */
export async function disableAutoTopupForReason(
  accountId: string,
  reason: AutoTopupDisabledReason,
): Promise<void> {
  const [row] = await db
    .update(walletAutoTopups)
    .set({
      enabled: false,
      stripePaymentMethodId: null,
      disabledReason: reason,
      chargePending: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletAutoTopups.accountId, accountId),
        eq(walletAutoTopups.enabled, true),
      ),
    )
    .returning({ amountCents: walletAutoTopups.amountCents });
  if (row) await notifyDisabled(accountId, row.amountCents, reason);
}

/** Turn the option off for whichever account saved this card, if any. */
export async function disableAutoTopupForPaymentMethod(
  paymentMethodId: string,
): Promise<void> {
  const [row] = await db
    .select({ accountId: walletAutoTopups.accountId })
    .from(walletAutoTopups)
    .where(eq(walletAutoTopups.stripePaymentMethodId, paymentMethodId))
    .limit(1);
  if (row)
    await disableAutoTopupForReason(row.accountId, "payment_method_removed");
}

async function customerDefaultPaymentMethod(
  stripeCustomerId: string,
): Promise<string | null> {
  if (!stripe) throw ERR.WAL_006();
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) return null;
  const ref = customer.invoice_settings.default_payment_method;
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function consentText(amountCents: number): string {
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
  }).format(amountCents / 100);
  const terms = config.wallet.autoTopupTermsUrl
    ? ` Terms: ${config.wallet.autoTopupTermsUrl}`
    : "";
  return `By saving this card you authorise automatic top-ups of ${amount} whenever your credit runs low. You can turn this off at any time from your profile.${terms}`;
}

async function createSetupCheckout(input: {
  userId: string;
  amountCents: number;
  stripeCustomerId: string;
}): Promise<string> {
  if (!stripe) throw ERR.WAL_006();
  const metadata = {
    purpose: AUTO_TOPUP_SETUP_PURPOSE,
    userId: input.userId,
    amountCents: String(input.amountCents),
  };
  const returnUrl = `${config.betterAuth.url}/profile`;
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    currency: "eur",
    customer: input.stripeCustomerId,
    client_reference_id: input.userId,
    metadata,
    setup_intent_data: { metadata },
    custom_text: { submit: { message: consentText(input.amountCents) } },
    success_url: `${returnUrl}?autotopup=success`,
    cancel_url: `${returnUrl}?autotopup=cancelled`,
  });
  if (!session.url) throw ERR.SRV_001("Stripe returned no checkout URL");
  return session.url;
}

/**
 * Turn automatic top-up on at `amountCents`. An account that already has it on
 * only changes the amount. Otherwise the customer's default card is reused;
 * without one (or after a failed charge on it) a Checkout in setup mode saves a
 * card first and the webhook finishes the activation.
 */
export async function enableAutoTopup(input: {
  userId: string;
  accountId: string;
  amountCents: number;
}): Promise<EnableAutoTopupResult> {
  if (!stripe) throw ERR.WAL_006();
  assertTopupAmount(input.amountCents);

  const existing = await findRow(input.accountId);
  if (existing?.enabled && existing.stripePaymentMethodId) {
    await activateAutoTopup({
      accountId: input.accountId,
      amountCents: input.amountCents,
      paymentMethodId: existing.stripePaymentMethodId,
    });
    return { enabled: true };
  }

  const customer = await getOrCreateBillingCustomer("user", input.userId);
  const reason = asReason(existing?.disabledReason ?? null);
  const reusable =
    reason !== null && CARD_FAILURES.includes(reason)
      ? null
      : await customerDefaultPaymentMethod(customer.stripeCustomerId);
  if (reusable) {
    await activateAutoTopup({
      accountId: input.accountId,
      amountCents: input.amountCents,
      paymentMethodId: reusable,
    });
    return { enabled: true };
  }

  const setupUrl = await createSetupCheckout({
    userId: input.userId,
    amountCents: input.amountCents,
    stripeCustomerId: customer.stripeCustomerId,
  });
  return { enabled: false, setupUrl };
}
