import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  billingCustomers,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { logger } from "../../logger.js";
import { stripe } from "../stripe.js";
import {
  productName,
  provisionPlanPrice,
  provisionPlanProduct,
  productImages,
  productUrl,
  updatePlanPriceNickname,
  updatePlanProduct,
} from "./catalog.js";
import {
  customerMatchesProfile,
  loadCustomerProfile,
} from "./customer-profile.js";
import {
  getOrCreateBillingCustomer,
  updateBillingCustomer,
} from "./customers.js";
import { pushPendingMeterEvents, countPendingMeterEvents } from "./usage.js";
import {
  refreshSubscriptionPresentation,
  syncStripeSubscription,
} from "./subscriptions.js";
import {
  planIdFromSubscription,
  stripeStateOf,
  stripeStatusToActive,
  syncSubscription,
  type WebhookLog,
} from "./webhooks.js";

/**
 * Reconciliation between the billing rows and the Stripe objects they point to.
 *
 * Two modes:
 * - `check` reads both sides and reports drift without writing anything.
 * - `repair` creates what is missing, relinks unusable objects, re-applies the
 *   Stripe subscription state, and (only when `cancelSuperseded` is set)
 *   cancels a subscription a newer one has replaced.
 *
 * Nothing is ever deleted from Stripe and an orphan subscription is reported,
 * never cancelled: without a local row there is no way to know whether a human
 * created it on purpose.
 */

export type ReconciliationMode = "check" | "repair";

export type DriftKind =
  | "customer_missing"
  | "customer_deleted"
  | "customer_profile"
  | "product_missing"
  | "product_unusable"
  | "product_metadata"
  | "price_missing"
  | "price_unusable"
  | "price_metadata"
  | "meter_unusable"
  | "subscription_missing"
  | "subscription_unlinked"
  | "subscription_state"
  | "subscription_plan"
  | "superseded_subscription"
  | "orphan_subscription";

export type DriftAction =
  "reported" | "created" | "relinked" | "updated" | "cancelled";

export interface ReconciliationIssue {
  kind: DriftKind;
  /** Human-readable, ids only: never a secret or a Stripe payload. */
  detail: string;
  action: DriftAction;
}

export interface ReconciliationSummary {
  customersCreated: number;
  productsCreated: number;
  pricesCreated: number;
  subscriptionsLinked: number;
  statesSynced: number;
  supersededCancelled: number;
}

export interface ReconciliationReport {
  mode: ReconciliationMode;
  issues: ReconciliationIssue[];
  summary: ReconciliationSummary;
  pendingMeterEvents: number;
  pushedMeterEvents: number;
}

export interface ReconcileOptions {
  mode?: ReconciliationMode;
  /** Cancel subscriptions a newer one has replaced. Only used by `repair`. */
  cancelSuperseded?: boolean;
  /** Recreate a subscription Stripe confirms as deleted. Off by default. */
  recreateMissing?: boolean;
  log?: WebhookLog;
}

const silentLog: WebhookLog = {
  warn: (obj, msg) => logger.warn(obj, msg),
  debug: (obj, msg) => logger.debug(obj, msg),
};

/** Stripe reports a deleted or unknown object as `resource_missing`. */
function isResourceMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "resource_missing";
}

async function loadOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isResourceMissing(err)) return null;
    throw err;
  }
}

function isDeleted(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "deleted" in value &&
    (value as { deleted?: unknown }).deleted === true
  );
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

function sameInstant(a: Date | null | undefined, b: Date | null): boolean {
  return sameDate(a ?? null, b);
}

interface PriceRow {
  id: string;
  planId: string;
  name: string;
  amount: string;
  currency: string;
  interval: string;
  billingType: string;
  featureKey: string | null;
  stripePriceId: string | null;
  stripeMeterId: string | null;
}

interface PlanRow {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  stripeProductId: string | null;
  appName: string;
  appSlug: string;
  appIcon: string | null;
  appUrl: string | null;
}

interface SubscriptionRow {
  userId: string;
  applicationId: string;
  planId: string;
  isActive: boolean;
  stripeSubscriptionId: string | null;
  stripeStatus: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}

function subscriptionPair(subscription: Stripe.Subscription): {
  userId: string | null;
  applicationId: string | null;
} {
  return {
    userId: subscription.metadata?.userId ?? null,
    applicationId: subscription.metadata?.applicationId ?? null,
  };
}

function pairKey(userId: string, applicationId: string): string {
  return `${userId}:${applicationId}`;
}

/**
 * Reconcile the billing database with the Stripe catalogue and subscriptions.
 * Returns every drift found; each entry states what was done (or that it was
 * only reported because the mode is `check`).
 */
export async function reconcileBilling(
  options: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const mode = options.mode ?? "repair";
  const apply = mode === "repair";
  const cancelSuperseded = apply && options.cancelSuperseded === true;
  const log = options.log ?? silentLog;
  const issues: ReconciliationIssue[] = [];
  const summary: ReconciliationSummary = {
    customersCreated: 0,
    productsCreated: 0,
    pricesCreated: 0,
    subscriptionsLinked: 0,
    statesSynced: 0,
    supersededCancelled: 0,
  };

  if (!stripe) {
    return {
      mode,
      issues,
      summary,
      pendingMeterEvents: 0,
      pushedMeterEvents: 0,
    };
  }

  const report = (kind: DriftKind, detail: string, action: DriftAction) =>
    issues.push({ kind, detail, action });

  // ── Customers ────────────────────────────────────────────────────────────
  const users = await db.select({ id: userTable.id }).from(userTable);
  const customerRows = await db
    .select({
      ownerId: billingCustomers.ownerId,
      stripeCustomerId: billingCustomers.stripeCustomerId,
    })
    .from(billingCustomers)
    .where(eq(billingCustomers.ownerType, "user"));
  const customerByUser = new Map(
    customerRows.map((row) => [row.ownerId, row.stripeCustomerId]),
  );
  // A user whose Customer was deleted cannot be repaired automatically: a new
  // subscription would target a dead customer. Skip its rows and report it.
  const blockedUsers = new Set<string>();
  const stripeCustomers = await listAllCustomers();

  for (const user of users) {
    const stripeCustomerId = customerByUser.get(user.id);
    if (!stripeCustomerId) {
      report(
        "customer_missing",
        `user ${user.id} has no Stripe customer`,
        "reported",
      );
      if (!apply) continue;
      try {
        await getOrCreateBillingCustomer("user", user.id);
      } catch (err) {
        logger.warn(
          { err: String(err), userId: user.id },
          "[billing] customer creation failed during reconciliation",
        );
        continue;
      }
      summary.customersCreated += 1;
      issues[issues.length - 1]!.action = "created";
      continue;
    }

    const stripeCustomer = stripeCustomers.get(stripeCustomerId);
    if (!stripeCustomer) {
      blockedUsers.add(user.id);
      report(
        "customer_deleted",
        `user ${user.id} points to a deleted Stripe customer ${stripeCustomerId}; manual review required`,
        "reported",
      );
      continue;
    }

    // Refresh the Customer's identity fields when the local profile drifted,
    // so an edit made while Stripe was unreachable is applied by repair mode.
    try {
      const profile = await loadCustomerProfile("user", user.id);
      if (!customerMatchesProfile(stripeCustomer, profile)) {
        report(
          "customer_profile",
          `customer ${stripeCustomerId} does not match user ${user.id}`,
          "reported",
        );
        if (apply) {
          try {
            await updateBillingCustomer(stripeCustomerId, profile);
            issues[issues.length - 1]!.action = "updated";
          } catch (err) {
            logger.warn(
              { err: String(err), stripeCustomerId },
              "[billing] customer profile update failed during reconciliation",
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err: String(err), userId: user.id },
        "[billing] customer profile check failed during reconciliation",
      );
    }
  }

  // ── Catalogue: Products, Prices, Meters ──────────────────────────────────
  const plans: PlanRow[] = await db
    .select({
      id: subscriptionPlans.id,
      applicationId: subscriptionPlans.applicationId,
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
      stripeProductId: subscriptionPlans.stripeProductId,
      appName: applications.name,
      appSlug: applications.slug,
      appIcon: applications.icon,
      appUrl: applications.url,
    })
    .from(subscriptionPlans)
    .innerJoin(
      applications,
      eq(applications.id, subscriptionPlans.applicationId),
    );

  const planById = new Map(plans.map((plan) => [plan.id, plan]));

  const priceRows: PriceRow[] = await db
    .select({
      id: subscriptionPlanPrices.id,
      planId: subscriptionPlanPrices.planId,
      name: subscriptionPlanPrices.name,
      amount: subscriptionPlanPrices.amount,
      currency: subscriptionPlanPrices.currency,
      interval: subscriptionPlanPrices.interval,
      billingType: subscriptionPlanPrices.billingType,
      featureKey: subscriptionPlanPrices.featureKey,
      stripePriceId: subscriptionPlanPrices.stripePriceId,
      stripeMeterId: subscriptionPlanPrices.stripeMeterId,
    })
    .from(subscriptionPlanPrices);
  const pricesByPlan = new Map<string, PriceRow[]>();
  const planByPriceId = new Map<string, string>();
  for (const row of priceRows) {
    const group = pricesByPlan.get(row.planId) ?? [];
    group.push(row);
    pricesByPlan.set(row.planId, group);
    if (row.stripePriceId) planByPriceId.set(row.stripePriceId, row.planId);
  }

  for (const plan of plans) {
    let stripeProductId = plan.stripeProductId;

    if (!stripeProductId) {
      report(
        "product_missing",
        `plan ${plan.id} has no Stripe product`,
        "reported",
      );
      if (apply) {
        stripeProductId = await provisionPlanProduct({
          applicationId: plan.applicationId,
          appName: plan.appName,
          planName: plan.name,
          description: plan.description,
          appIcon: plan.appIcon,
          appUrl: plan.appUrl,
        });
        if (stripeProductId) {
          await db
            .update(subscriptionPlans)
            .set({ stripeProductId })
            .where(eq(subscriptionPlans.id, plan.id));
          summary.productsCreated += 1;
          issues[issues.length - 1]!.action = "created";
        }
      }
    } else {
      const currentProductId = stripeProductId;
      const product = await loadOrNull(() =>
        stripe!.products.retrieve(currentProductId),
      );
      if (!product || isDeleted(product) || !product.active) {
        report(
          "product_unusable",
          `plan ${plan.id} points to an inactive or deleted product ${currentProductId}`,
          "reported",
        );
        if (apply) {
          const replacement = await provisionPlanProduct({
            applicationId: plan.applicationId,
            appName: plan.appName,
            planName: plan.name,
            description: plan.description,
            appIcon: plan.appIcon,
            appUrl: plan.appUrl,
          });
          if (replacement) {
            stripeProductId = replacement;
            await db
              .update(subscriptionPlans)
              .set({ stripeProductId })
              .where(eq(subscriptionPlans.id, plan.id));
            summary.productsCreated += 1;
            issues[issues.length - 1]!.action = "relinked";
          }
        }
      } else {
        const expectedName = productName(plan.appName, plan.name);
        const metadataOk =
          product.metadata?.applicationId === plan.applicationId;
        const descriptionOk =
          (product.description ?? null) === (plan.description ?? null);
        const expectedImages = productImages(plan.appIcon);
        const imagesOk =
          JSON.stringify(product.images ?? []) ===
          JSON.stringify(expectedImages);
        const urlOk = (product.url ?? "") === productUrl(plan.appUrl);
        if (
          product.name !== expectedName ||
          !metadataOk ||
          !descriptionOk ||
          !imagesOk ||
          !urlOk
        ) {
          report(
            "product_metadata",
            `product ${stripeProductId} does not match plan ${plan.id}`,
            "reported",
          );
          if (apply) {
            await updatePlanProduct({
              stripeProductId: currentProductId,
              applicationId: plan.applicationId,
              appName: plan.appName,
              planName: plan.name,
              description: plan.description,
              appIcon: plan.appIcon,
              appUrl: plan.appUrl,
            });
            issues[issues.length - 1]!.action = "updated";
          }
        }
      }
    }

    for (const price of pricesByPlan.get(plan.id) ?? []) {
      const provision = async (): Promise<void> => {
        const created = await provisionPlanPrice({
          applicationId: plan.applicationId,
          appSlug: plan.appSlug,
          appName: plan.appName,
          stripeProductId,
          planId: plan.id,
          name: price.name,
          amount: Number(price.amount),
          currency: price.currency,
          interval: price.interval,
          billingType: price.billingType as "fixed" | "metered",
          featureKey: price.featureKey,
        });
        if (!created.stripePriceId) return;
        await db
          .update(subscriptionPlanPrices)
          .set({
            stripePriceId: created.stripePriceId,
            stripeMeterId: created.stripeMeterId,
          })
          .where(eq(subscriptionPlanPrices.id, price.id));
        summary.pricesCreated += 1;
      };

      if (!price.stripePriceId) {
        report(
          "price_missing",
          `price ${price.id} has no Stripe price`,
          "reported",
        );
        if (apply) {
          await provision();
          issues[issues.length - 1]!.action = "created";
        }
        continue;
      }

      const currentPriceId = price.stripePriceId;
      const stripePrice = await loadOrNull(() =>
        stripe!.prices.retrieve(currentPriceId),
      );
      if (!stripePrice || !stripePrice.active) {
        report(
          "price_unusable",
          `price ${price.id} points to an inactive or deleted price ${currentPriceId}`,
          "reported",
        );
        if (apply) {
          await provision();
          issues[issues.length - 1]!.action = "relinked";
        }
        continue;
      }

      const productId =
        typeof stripePrice.product === "string"
          ? stripePrice.product
          : stripePrice.product.id;
      if (stripeProductId && productId !== stripeProductId) {
        report(
          "price_metadata",
          `price ${price.id} belongs to product ${productId}, expected ${stripeProductId}`,
          "reported",
        );
        if (apply) {
          await provision();
          issues[issues.length - 1]!.action = "relinked";
        }
        continue;
      }

      if (stripePrice.nickname !== price.name) {
        report(
          "price_metadata",
          `price ${currentPriceId} nickname differs from price ${price.id}`,
          "reported",
        );
        if (apply) {
          await updatePlanPriceNickname(currentPriceId, price.name);
          issues[issues.length - 1]!.action = "updated";
        }
      }

      if (price.billingType === "metered" && !price.stripeMeterId) {
        report(
          "meter_unusable",
          `metered price ${price.id} has no Stripe meter`,
          "reported",
        );
        if (apply) {
          await provision();
          issues[issues.length - 1]!.action = "relinked";
        }
        continue;
      }

      if (price.billingType === "metered" && price.stripeMeterId) {
        const currentMeterId = price.stripeMeterId;
        const meter = await loadOrNull(() =>
          stripe!.billing.meters.retrieve(currentMeterId),
        );
        if (!meter || meter.status !== "active") {
          report(
            "meter_unusable",
            `metered price ${price.id} points to an inactive or deleted meter ${currentMeterId}`,
            "reported",
          );
          if (apply) {
            await provision();
            issues[issues.length - 1]!.action = "relinked";
          }
        }
      }
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────────
  const subscriptionRows: SubscriptionRow[] = await db
    .select({
      userId: userSubscriptions.userId,
      applicationId: userSubscriptions.applicationId,
      planId: userSubscriptions.planId,
      isActive: userSubscriptions.isActive,
      stripeSubscriptionId: userSubscriptions.stripeSubscriptionId,
      stripeStatus: userSubscriptions.stripeStatus,
      currentPeriodStart: userSubscriptions.currentPeriodStart,
      currentPeriodEnd: userSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: userSubscriptions.cancelAtPeriodEnd,
      canceledAt: userSubscriptions.canceledAt,
    })
    .from(userSubscriptions);

  const stripeSubscriptions = await listAllSubscriptions();
  const byStripeId = new Map(
    stripeSubscriptions.map((subscription) => [subscription.id, subscription]),
  );
  const linkedIds = new Set(
    subscriptionRows
      .map((row) => row.stripeSubscriptionId)
      .filter((id): id is string => id !== null),
  );
  const rowByPair = new Map(
    subscriptionRows.map((row) => [
      pairKey(row.userId, row.applicationId),
      row,
    ]),
  );
  const claimed = new Set(linkedIds);

  for (const row of subscriptionRows) {
    if (blockedUsers.has(row.userId)) continue;
    if (!row.stripeSubscriptionId) {
      // Adopt any live Stripe subscription of the pair, even past_due/unpaid:
      // creating a second one would double-bill while the first still exists.
      const candidates = stripeSubscriptions.filter((subscription) => {
        const pair = subscriptionPair(subscription);
        return (
          pair.userId === row.userId &&
          pair.applicationId === row.applicationId &&
          subscription.status !== "canceled" &&
          !claimed.has(subscription.id)
        );
      });
      const candidate =
        candidates.find(
          (subscription) =>
            subscription.status === "active" ||
            subscription.status === "trialing",
        ) ?? candidates[0];
      report(
        "subscription_unlinked",
        `(${row.userId}, ${row.applicationId}) has no linked Stripe subscription${candidate ? `; ${candidate.id} can be adopted` : ""}`,
        "reported",
      );
      if (candidate) claimed.add(candidate.id);
      if (!apply) continue;
      if (candidate) {
        if (await syncSubscription(candidate, log)) {
          row.stripeSubscriptionId = candidate.id;
          summary.subscriptionsLinked += 1;
          issues[issues.length - 1]!.action = "relinked";
        }
      } else if (row.isActive) {
        if (
          await syncStripeSubscription({
            userId: row.userId,
            applicationId: row.applicationId,
            planId: row.planId,
          })
        ) {
          summary.subscriptionsLinked += 1;
          issues[issues.length - 1]!.action = "created";
        }
      }
      continue;
    }

    const listed = byStripeId.get(row.stripeSubscriptionId);
    // The account-wide listing can miss a subscription whose Customer row was
    // lost or moved. Only a confirmed `resource_missing` is a deletion.
    const subscription =
      listed ??
      (await loadOrNull(() =>
        stripe!.subscriptions.retrieve(row.stripeSubscriptionId!),
      ));
    if (subscription && !listed) byStripeId.set(subscription.id, subscription);
    if (!subscription) {
      report(
        "subscription_missing",
        `(${row.userId}, ${row.applicationId}) points to a deleted subscription ${row.stripeSubscriptionId}${row.isActive ? "" : "; inactive row, not recreated"}`,
        "reported",
      );
      if (!apply || !options.recreateMissing || !row.isActive) continue;
      await db
        .update(userSubscriptions)
        .set({
          stripeSubscriptionId: null,
          stripeStatus: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canceledAt: null,
        })
        .where(
          and(
            eq(userSubscriptions.userId, row.userId),
            eq(userSubscriptions.applicationId, row.applicationId),
          ),
        );
      if (
        await syncStripeSubscription({
          userId: row.userId,
          applicationId: row.applicationId,
          planId: row.planId,
        })
      ) {
        summary.subscriptionsLinked += 1;
        issues[issues.length - 1]!.action = "relinked";
      }
      continue;
    }

    const priceId = subscriptionPriceId(subscription);
    const stripePlanId =
      (priceId ? planByPriceId.get(priceId) : undefined) ??
      (await planIdFromSubscription(subscription));
    if (stripePlanId && stripePlanId !== row.planId) {
      report(
        "subscription_plan",
        `(${row.userId}, ${row.applicationId}) holds plan ${row.planId} but Stripe bills ${stripePlanId}`,
        "reported",
      );
      if (apply && (await syncSubscription(subscription, log))) {
        summary.statesSynced += 1;
        issues[issues.length - 1]!.action = "updated";
      }
      continue;
    }

    const planRow = planById.get(row.planId);
    const expectedDescription = planRow
      ? productName(planRow.appName, planRow.name)
      : undefined;
    const presentationOk =
      subscription.metadata?.userId === row.userId &&
      subscription.metadata?.applicationId === row.applicationId &&
      subscription.metadata?.planId === row.planId &&
      (expectedDescription === undefined ||
        subscription.description === expectedDescription);
    const presentationRelevant =
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired";
    if (apply && presentationRelevant && !presentationOk) {
      try {
        await refreshSubscriptionPresentation({
          stripeSubscriptionId: subscription.id,
          userId: row.userId,
          applicationId: row.applicationId,
          planId: row.planId,
          description: expectedDescription,
        });
      } catch (err) {
        logger.warn(
          { err: String(err), stripeSubscriptionId: subscription.id },
          "[billing] subscription presentation update failed during reconciliation",
        );
      }
    }

    const state = stripeStateOf(subscription);
    if (
      row.stripeStatus !== subscription.status ||
      row.isActive !== stripeStatusToActive(subscription.status) ||
      row.cancelAtPeriodEnd !== state.cancelAtPeriodEnd ||
      !sameDate(row.canceledAt, state.canceledAt) ||
      !sameInstant(row.currentPeriodStart, state.currentPeriodStart) ||
      !sameInstant(row.currentPeriodEnd, state.currentPeriodEnd)
    ) {
      report(
        "subscription_state",
        `(${row.userId}, ${row.applicationId}) local state differs from subscription ${subscription.id}`,
        "reported",
      );
      if (apply && (await syncSubscription(subscription, log))) {
        summary.statesSynced += 1;
        issues[issues.length - 1]!.action = "updated";
      }
    }
  }

  for (const subscription of stripeSubscriptions) {
    if (claimed.has(subscription.id)) continue;
    const pair = subscriptionPair(subscription);
    const row =
      pair.userId && pair.applicationId
        ? rowByPair.get(pairKey(pair.userId, pair.applicationId))
        : undefined;
    const replacementId = row?.stripeSubscriptionId ?? null;
    const replacement = replacementId ? byStripeId.get(replacementId) : null;
    const replacementLive =
      replacement?.status === "active" || replacement?.status === "trialing";

    if (row && replacementId && replacementId !== subscription.id) {
      if (subscription.status !== "canceled") {
        report(
          "superseded_subscription",
          `subscription ${subscription.id} was replaced by ${replacementId} for (${row.userId}, ${row.applicationId})`,
          "reported",
        );
        // Only cancel when the replacement is confirmed live locally.
        if (cancelSuperseded && replacementLive) {
          await stripe!.subscriptions.cancel(subscription.id);
          summary.supersededCancelled += 1;
          issues[issues.length - 1]!.action = "cancelled";
        }
      }
      continue;
    }

    if (!replacementId && subscription.status !== "canceled") {
      report(
        "orphan_subscription",
        `subscription ${subscription.id} (${subscription.status}) has no confirmed local link; manual review required`,
        "reported",
      );
    }
  }

  // ── Meter event outbox ───────────────────────────────────────────────────
  const pendingMeterEvents = await countPendingMeterEvents();
  const pushedMeterEvents = apply ? await pushPendingMeterEvents() : 0;

  return {
    mode,
    issues,
    summary,
    pendingMeterEvents,
    pushedMeterEvents,
  };
}

function subscriptionPriceId(subscription: Stripe.Subscription): string | null {
  const price = subscription.items.data[0]?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

/** Every Customer id in the account, paginated once instead of per user. */
async function listAllCustomers(): Promise<Map<string, Stripe.Customer>> {
  if (!stripe) return new Map();
  const customers = new Map<string, Stripe.Customer>();
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const customer of page.data) customers.set(customer.id, customer);
    if (!page.has_more || page.data.length === 0) return customers;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

/** Every subscription in the account, including canceled ones. */
async function listAllSubscriptions(): Promise<Stripe.Subscription[]> {
  if (!stripe) return [];
  const subscriptions: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    subscriptions.push(...page.data);
    if (!page.has_more || page.data.length === 0) return subscriptions;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}
