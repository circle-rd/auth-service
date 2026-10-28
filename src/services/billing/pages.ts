import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  subscriptionPlanPrices,
  subscriptionPlans,
  userApplications,
  userSubscriptions,
} from "../../db/schema.js";
import { isStripeConfigured } from "../stripe.js";
import { getApplicationUsage } from "./app-views.js";
import { httpsOnly } from "./urls.js";
import { listApplicationInvoices } from "./invoices.js";

/**
 * Data behind the delegated billing pages (subscribe, invoices, billing-usage).
 *
 * Every page is for the signed-in user, in one application: the application
 * must have `billing_mode = delegated`, and the user must hold an active access
 * to it. Anything else is refused before a template is chosen (see the routes),
 * so the pages never reveal another user's or application's billing.
 */

export class BillingPageAccessError extends Error {
  constructor(
    readonly code: "not_delegated" | "no_access" | "no_such_application",
  ) {
    super(code);
  }
}

export interface DelegatedApp {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

/** The application, when it delegates billing and the user may use it. */
export async function requireDelegatedAccess(
  userId: string,
  slug: string,
): Promise<DelegatedApp> {
  const [app] = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      icon: applications.icon,
      billingMode: applications.billingMode,
      isActive: applications.isActive,
    })
    .from(applications)
    .where(eq(applications.slug, slug))
    .limit(1);
  if (!app || !app.isActive || app.billingMode !== "delegated") {
    throw new BillingPageAccessError(
      app ? "not_delegated" : "no_such_application",
    );
  }
  const [access] = await db
    .select({ id: userApplications.id })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, app.id),
        eq(userApplications.isActive, true),
      ),
    )
    .limit(1);
  if (!access) throw new BillingPageAccessError("no_access");
  return { id: app.id, slug: app.slug, name: app.name, icon: app.icon };
}

const INTERVAL_LABEL: Record<string, Record<string, string>> = {
  en: { month: "month", year: "year" },
  fr: { month: "mois", year: "an" },
};

function intervalLabel(interval: string, locale: string): string {
  const labels = INTERVAL_LABEL[locale.slice(0, 2)] ?? INTERVAL_LABEL.en!;
  return labels[interval] ?? interval;
}

function money(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function date(value: string | null, locale: string): string | null {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(value),
      )
    : null;
}

export interface SubscribePlan {
  id: string;
  name: string;
  description: string | null;
  isCurrent: boolean;
  isFree: boolean;
  priceLabel: string;
  checkoutAvailable: boolean;
}

/** Plans of the application, with the user's current one flagged. */
export async function subscribePageData(input: {
  userId: string;
  app: DelegatedApp;
  locale: string;
}): Promise<Record<string, unknown>> {
  const plans = await db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
    })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, input.app.id));

  const prices = plans.length
    ? await db
        .select({
          planId: subscriptionPlanPrices.planId,
          amount: subscriptionPlanPrices.amount,
          currency: subscriptionPlanPrices.currency,
          interval: subscriptionPlanPrices.interval,
        })
        .from(subscriptionPlanPrices)
        .where(
          and(
            inArray(
              subscriptionPlanPrices.planId,
              plans.map((p) => p.id),
            ),
            eq(subscriptionPlanPrices.billingType, "fixed"),
          ),
        )
    : [];

  const [current] = await db
    .select({
      planId: userSubscriptions.planId,
      isActive: userSubscriptions.isActive,
    })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, input.userId),
        eq(userSubscriptions.applicationId, input.app.id),
      ),
    )
    .limit(1);

  const stripeOn = isStripeConfigured();
  const view: SubscribePlan[] = plans.map((plan) => {
    const planPrices = prices.filter((p) => p.planId === plan.id);
    const recurring = planPrices.find((p) => p.interval !== "one_time");
    const isFree = !recurring || Number(recurring.amount) === 0;
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      isCurrent: current?.planId === plan.id && current.isActive,
      isFree,
      priceLabel: recurring
        ? `${money(Number(recurring.amount), recurring.currency, input.locale)} / ${intervalLabel(recurring.interval, input.locale)}`
        : "",
      // A paid plan is bought through Checkout only when Stripe is configured.
      checkoutAvailable: stripeOn && !isFree,
    };
  });

  return {
    APPLICATION_ID: input.app.id,
    APP_SLUG: input.app.slug,
    APPLICATION_NAME: input.app.name,
    PLANS: view,
    STRIPE_CONFIGURED: stripeOn,
    BILLING_PORTAL_AVAILABLE: stripeOn,
  };
}

/** The user's invoices in the application, newest first (one page). */
export async function invoicesPageData(input: {
  userId: string;
  app: DelegatedApp;
  locale: string;
  cursor?: string;
}): Promise<Record<string, unknown>> {
  const page = await listApplicationInvoices({
    userId: input.userId,
    applicationId: input.app.id,
    limit: 20,
    cursor: input.cursor,
  });
  return {
    APPLICATION_ID: input.app.id,
    APP_SLUG: input.app.slug,
    APPLICATION_NAME: input.app.name,
    INVOICES: page.items.map((i) => ({
      id: i.id,
      date: date(i.createdAt, input.locale),
      status: i.status,
      total: money(i.amountDue, i.currency, input.locale),
      paid: money(i.amountPaid, i.currency, input.locale),
      hostedUrl: httpsOnly(i.hostedInvoiceUrl),
      pdfUrl: httpsOnly(i.invoicePdf),
    })),
    NEXT_CURSOR: page.nextCursor,
    HAS_INVOICES: page.items.length > 0,
  };
}

/** Metered usage of the current period, rendered for display. */
export async function billingUsagePageData(input: {
  userId: string;
  app: DelegatedApp;
  locale: string;
}): Promise<Record<string, unknown>> {
  const usage = await getApplicationUsage({
    userId: input.userId,
    applicationId: input.app.id,
  });
  const fmt = new Intl.NumberFormat(input.locale);
  return {
    APP_SLUG: input.app.slug,
    APPLICATION_NAME: input.app.name,
    PERIOD_START: date(usage.periodStart, input.locale),
    FEATURES: usage.features.map((f) => ({
      featureKey: f.featureKey,
      unit: f.unit ?? "",
      used: fmt.format(f.used),
      limit: f.usageLimit < 0 ? null : fmt.format(f.usageLimit),
      remaining: f.remaining === null ? null : fmt.format(f.remaining),
      percent:
        f.usageLimit > 0
          ? Math.min(100, Math.round((f.used / f.usageLimit) * 100))
          : null,
    })),
    HAS_FEATURES: usage.features.length > 0,
  };
}
