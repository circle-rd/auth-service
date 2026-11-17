import Stripe from "stripe";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { walletAccounts, walletAutoTopups } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { findBillingCustomer } from "../billing/customers.js";
import { stripe } from "../stripe.js";
import {
  AUTO_TOPUP_COOLDOWN_MS,
  AUTO_TOPUP_THRESHOLD_MICRO,
  disableAutoTopupForReason,
  type AutoTopupDisabledReason,
} from "./auto-topup.js";
import { CENTS_TO_MICRO } from "./checkout.js";

const INVOICE_DESCRIPTION = "Wallet credit top-up (automatic)";

/** A charge whose credit has not landed blocks new ones for this long. */
const PENDING_TIMEOUT_MS = 24 * 60 * 60_000;

/** Accounts with the option on, a low balance and no recent or pending attempt. */
const dueCondition = (cutoff: Date, pendingCutoff: Date) =>
  and(
    eq(walletAutoTopups.enabled, true),
    eq(walletAccounts.ownerType, "user"),
    eq(walletAccounts.isUnlimited, false),
    lte(walletAccounts.balance, AUTO_TOPUP_THRESHOLD_MICRO),
    or(
      isNull(walletAutoTopups.lastAttemptAt),
      lte(walletAutoTopups.lastAttemptAt, cutoff),
    ),
    or(
      eq(walletAutoTopups.chargePending, false),
      lte(walletAutoTopups.lastAttemptAt, pendingCutoff),
    ),
  );

function failureReason(err: unknown): AutoTopupDisabledReason | null {
  if (!(err instanceof Stripe.errors.StripeCardError)) return null;
  return err.code === "authentication_required"
    ? "authentication_required"
    : "payment_failed";
}

async function discardInvoice(invoiceId: string): Promise<boolean> {
  if (!stripe) return false;
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status === "draft") await stripe.invoices.del(invoiceId);
    else if (invoice.status === "open")
      await stripe.invoices.voidInvoice(invoiceId);
    else return false;
    return true;
  } catch (err) {
    logger.warn(
      { err: String(err), invoiceId },
      "[wallet] could not discard the auto top-up invoice",
    );
    return false;
  }
}

async function clearPending(accountId: string): Promise<void> {
  await db
    .update(walletAutoTopups)
    .set({ chargePending: false, updatedAt: new Date() })
    .where(eq(walletAutoTopups.accountId, accountId));
}

/**
 * Charge the saved card through a Stripe invoice, so the top-up has a receipt
 * and shows in the profile like a manual one. The credit itself is applied by
 * the `invoice.paid` webhook. A card failure turns the option off.
 */
async function chargeInvoice(input: {
  accountId: string;
  userId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  amountCents: number;
  attemptKey: string;
}): Promise<void> {
  if (!stripe) return;
  const metadata = {
    purpose: "wallet_topup",
    trigger: "auto",
    userId: input.userId,
    creditMicro: (BigInt(input.amountCents) * CENTS_TO_MICRO).toString(),
  };
  const opts = (step: string) => ({
    idempotencyKey: `${input.attemptKey}:${step}`,
  });

  let invoiceId: string | undefined;
  try {
    const invoice = await stripe.invoices.create(
      {
        customer: input.stripeCustomerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        currency: "eur",
        default_payment_method: input.paymentMethodId,
        description: INVOICE_DESCRIPTION,
        pending_invoice_items_behavior: "exclude",
        metadata,
      },
      opts("invoice"),
    );
    invoiceId = invoice.id;
    await stripe.invoiceItems.create(
      {
        customer: input.stripeCustomerId,
        invoice: invoice.id,
        currency: "eur",
        amount: input.amountCents,
        description: "Credits",
      },
      opts("item"),
    );
    await stripe.invoices.finalizeInvoice(
      invoice.id,
      { auto_advance: false },
      opts("finalize"),
    );
    await stripe.invoices.pay(
      invoice.id,
      { off_session: true, payment_method: input.paymentMethodId },
      opts("pay"),
    );
  } catch (err) {
    const discarded = invoiceId ? await discardInvoice(invoiceId) : true;
    const reason = failureReason(err);
    if (reason) {
      logger.warn(
        { accountId: input.accountId, reason },
        "[wallet] auto top-up charge failed; option turned off",
      );
      await disableAutoTopupForReason(input.accountId, reason);
      return;
    }
    // Nothing was charged: let the next attempt go ahead. Otherwise the outcome
    // is unknown and the pending flag keeps a second charge from starting.
    if (discarded) await clearPending(input.accountId);
    throw err;
  }
}

/**
 * Top up the account when it is due. The claim on `last_attempt_at` is what
 * keeps concurrent triggers (usage callbacks, the sweeper) from charging twice.
 * Returns whether a charge was attempted.
 */
export async function runAutoTopupIfDue(accountId: string): Promise<boolean> {
  if (!stripe) return false;
  const now = new Date();
  const cutoff = new Date(now.getTime() - AUTO_TOPUP_COOLDOWN_MS);
  const pendingCutoff = new Date(now.getTime() - PENDING_TIMEOUT_MS);

  const [due] = await db
    .select({
      ownerId: walletAccounts.ownerId,
      amountCents: walletAutoTopups.amountCents,
      paymentMethodId: walletAutoTopups.stripePaymentMethodId,
    })
    .from(walletAutoTopups)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletAutoTopups.accountId),
    )
    .where(
      and(
        eq(walletAutoTopups.accountId, accountId),
        dueCondition(cutoff, pendingCutoff),
      ),
    )
    .limit(1);
  if (!due?.paymentMethodId) return false;

  const claimed = await db
    .update(walletAutoTopups)
    .set({ lastAttemptAt: now, chargePending: true, updatedAt: now })
    .where(
      and(
        eq(walletAutoTopups.accountId, accountId),
        eq(walletAutoTopups.enabled, true),
        or(
          isNull(walletAutoTopups.lastAttemptAt),
          lte(walletAutoTopups.lastAttemptAt, cutoff),
        ),
        or(
          eq(walletAutoTopups.chargePending, false),
          lte(walletAutoTopups.lastAttemptAt, pendingCutoff),
        ),
      ),
    )
    .returning({ id: walletAutoTopups.id });
  if (claimed.length === 0) return false;

  const customer = await findBillingCustomer("user", due.ownerId);
  if (!customer) {
    await disableAutoTopupForReason(accountId, "payment_method_removed");
    return false;
  }
  await chargeInvoice({
    accountId,
    userId: due.ownerId,
    stripeCustomerId: customer.stripeCustomerId,
    paymentMethodId: due.paymentMethodId,
    amountCents: due.amountCents,
    attemptKey: `autotopup:${accountId}:${now.getTime()}`,
  });
  return true;
}

/** Fire-and-forget entry point for hooks: never throws. */
export function triggerAutoTopup(accountId: string): void {
  void runAutoTopupIfDue(accountId).catch((err: unknown) =>
    logger.warn(
      { err: String(err), accountId },
      "[wallet] auto top-up attempt failed",
    ),
  );
}

export async function sweepAutoTopups(): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - AUTO_TOPUP_COOLDOWN_MS);
  const pendingCutoff = new Date(now - PENDING_TIMEOUT_MS);
  const rows = await db
    .select({ accountId: walletAutoTopups.accountId })
    .from(walletAutoTopups)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletAutoTopups.accountId),
    )
    .where(dueCondition(cutoff, pendingCutoff));
  let attempted = 0;
  for (const { accountId } of rows) {
    try {
      if (await runAutoTopupIfDue(accountId)) attempted += 1;
    } catch (err) {
      logger.warn(
        { err: String(err), accountId },
        "[wallet] auto top-up sweep failed for an account",
      );
    }
  }
  return attempted;
}

/** Catch up on accounts whose trigger was missed, now then every few minutes. */
export function startAutoTopupSweeper(): void {
  if (!stripe) return;
  const run = () =>
    sweepAutoTopups().catch((err: unknown) =>
      logger.warn({ err: String(err) }, "[wallet] auto top-up sweep failed"),
    );
  void run();
  setInterval(run, AUTO_TOPUP_COOLDOWN_MS).unref();
}
