import type Stripe from "stripe";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  billingCustomers,
  stripeInvoices,
  userSubscriptions,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";
import type { WebhookLog } from "./webhooks.js";
import { subscriptionIdFromInvoice } from "./webhooks.js";
import { httpsOnly } from "./urls.js";

/**
 * Read cache of Stripe invoices, filled by the invoice webhooks. Nothing here
 * calls Stripe: the profile and the application read API serve from this table.
 *
 * Ownership: the invoice's Stripe Customer is mapped to a user through
 * `billing_customers`; the `userId` metadata we set on the subscription or on a
 * wallet checkout is the fallback. An invoice with no resolvable owner is not
 * cached (it cannot be shown to anyone) and is logged.
 */

export const WALLET_TOPUP_PURPOSE = "wallet_topup";

export const DEFAULT_INVOICE_PAGE_SIZE = 20;
export const MAX_INVOICE_PAGE_SIZE = 100;

function metaString(
  meta: Stripe.Metadata | null | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function customerId(invoice: Stripe.Invoice): string | undefined {
  const ref = invoice.customer;
  if (!ref) return undefined;
  return typeof ref === "string" ? ref : ref.id;
}

async function ownerFromCustomer(
  stripeCustomerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: billingCustomers.ownerId })
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.ownerType, "user"),
        eq(billingCustomers.stripeCustomerId, stripeCustomerId),
      ),
    )
    .limit(1);
  return row?.ownerId ?? null;
}

/** The application an invoice belongs to, or null (wallet top-up, or unknown). */
async function applicationOf(
  invoice: Stripe.Invoice,
  subscriptionId: string | undefined,
): Promise<string | null> {
  if (metaString(invoice.metadata, "purpose") === WALLET_TOPUP_PURPOSE) {
    return null;
  }
  if (subscriptionId) {
    const [row] = await db
      .select({ applicationId: userSubscriptions.applicationId })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.stripeSubscriptionId, subscriptionId))
      .limit(1);
    if (row) return row.applicationId;
  }
  // The subscription row may not exist yet when its first invoice arrives:
  // fall back to the application id we put in the subscription metadata.
  const fromMeta = z
    .string()
    .uuid()
    .safeParse(
      metaString(
        invoice.parent?.subscription_details?.metadata,
        "applicationId",
      ),
    );
  if (!fromMeta.success) return null;
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, fromMeta.data))
    .limit(1);
  return app?.id ?? null;
}

/**
 * Cache one invoice from a webhook event. Returns false when the owner cannot be
 * resolved (the event is then ignored). A stale event (older than the one already
 * applied) leaves the row untouched.
 */
export async function cacheStripeInvoice(
  invoice: Stripe.Invoice,
  eventCreated: number,
  log: WebhookLog,
): Promise<boolean> {
  const stripeCustomer = customerId(invoice);
  const userId =
    (stripeCustomer ? await ownerFromCustomer(stripeCustomer) : null) ??
    metaString(invoice.metadata, "userId") ??
    metaString(invoice.parent?.subscription_details?.metadata, "userId") ??
    null;
  if (!userId) {
    log.warn(
      { invoiceId: invoice.id },
      "billing: invoice owner unknown; not cached",
    );
    return false;
  }

  const subscriptionId = subscriptionIdFromInvoice(invoice) ?? undefined;
  const applicationId = await applicationOf(invoice, subscriptionId);
  const lastEventAt = new Date(eventCreated * 1000);
  const values = {
    stripeInvoiceId: invoice.id,
    userId,
    applicationId,
    stripeSubscriptionId: subscriptionId ?? null,
    status: invoice.status ?? "draft",
    billingReason: invoice.billing_reason ?? null,
    currency: invoice.currency,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    amountRemaining: invoice.amount_remaining,
    periodStart: invoice.period_start
      ? new Date(invoice.period_start * 1000)
      : null,
    periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
    hostedInvoiceUrl: httpsOnly(invoice.hosted_invoice_url),
    invoicePdf: httpsOnly(invoice.invoice_pdf),
    stripeCreatedAt: new Date(invoice.created * 1000),
    lastEventAt,
    updatedAt: new Date(),
  };

  await db
    .insert(stripeInvoices)
    .values(values)
    .onConflictDoUpdate({
      target: stripeInvoices.stripeInvoiceId,
      set: values,
      setWhere: sql`${stripeInvoices.lastEventAt} <= excluded.last_event_at`,
    });
  return true;
}

export interface InvoiceView {
  id: string;
  status: string;
  billingReason: string | null;
  currency: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

// Keyset pagination on (stripe_created_at, stripe_invoice_id): newest first, and
// a new invoice never shifts the pages already read. Millisecond precision is
// exact here because Stripe timestamps are whole seconds.
const cursorSchema = z.object({
  t: z.string().datetime(),
  i: z.string().min(1).max(255),
});

function encodeCursor(position: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw ERR.APP_001("Invalid pagination cursor");
  }
}

export interface ListInvoicesInput {
  userId: string;
  /** Set for an application's read API: an invoice of another application is never listed. */
  applicationId?: string;
  limit?: number;
  cursor?: string;
}

export interface InvoicePage {
  items: InvoiceView[];
  nextCursor: string | null;
}

/** The invoices of a user, newest first: all of them, or those of one application. */
export async function listInvoices(
  input: ListInvoicesInput,
): Promise<InvoicePage> {
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_INVOICE_PAGE_SIZE),
    MAX_INVOICE_PAGE_SIZE,
  );
  const position = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await db
    .select({
      stripeInvoiceId: stripeInvoices.stripeInvoiceId,
      status: stripeInvoices.status,
      billingReason: stripeInvoices.billingReason,
      currency: stripeInvoices.currency,
      amountDue: stripeInvoices.amountDue,
      amountPaid: stripeInvoices.amountPaid,
      amountRemaining: stripeInvoices.amountRemaining,
      periodStart: stripeInvoices.periodStart,
      periodEnd: stripeInvoices.periodEnd,
      stripeCreatedAt: stripeInvoices.stripeCreatedAt,
      hostedInvoiceUrl: stripeInvoices.hostedInvoiceUrl,
      invoicePdf: stripeInvoices.invoicePdf,
    })
    .from(stripeInvoices)
    .where(
      and(
        eq(stripeInvoices.userId, input.userId),
        input.applicationId
          ? eq(stripeInvoices.applicationId, input.applicationId)
          : undefined,
        position
          ? sql`(${stripeInvoices.stripeCreatedAt}, ${stripeInvoices.stripeInvoiceId}) < (${position.t}::timestamptz, ${position.i})`
          : undefined,
      ),
    )
    .orderBy(
      desc(stripeInvoices.stripeCreatedAt),
      desc(stripeInvoices.stripeInvoiceId),
    )
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.stripeInvoiceId,
      status: r.status,
      billingReason: r.billingReason,
      currency: r.currency,
      amountDue: r.amountDue,
      amountPaid: r.amountPaid,
      amountRemaining: r.amountRemaining,
      periodStart: r.periodStart?.toISOString() ?? null,
      periodEnd: r.periodEnd?.toISOString() ?? null,
      createdAt: r.stripeCreatedAt.toISOString(),
      hostedInvoiceUrl: httpsOnly(r.hostedInvoiceUrl),
      invoicePdf: httpsOnly(r.invoicePdf),
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            t: last.stripeCreatedAt.toISOString(),
            i: last.stripeInvoiceId,
          })
        : null,
  };
}

/** The invoices of one application, for its read API. */
export function listApplicationInvoices(
  input: ListInvoicesInput & { applicationId: string },
): Promise<InvoicePage> {
  return listInvoices(input);
}
