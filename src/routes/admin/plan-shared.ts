import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, subscriptionPlans } from "../../db/schema.js";
import { ERR } from "../../errors.js";

/** Metered feature keys use the same charset as consumption keys. */
const FEATURE_KEY_RE = /^[a-zA-Z0-9.]+$/;

/**
 * Included features are plain values. A metered feature is a metered price
 * (billed by usage, with its cap), never a feature: declaring one here would
 * be a second source of truth beside the price row that bills it.
 */
export const featuresSchema = z
  .record(z.string().min(1).max(64), z.unknown())
  .superRefine((features, ctx) => {
    for (const [key, value] of Object.entries(features)) {
      const plain =
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean";
      if (!plain) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            "A feature is a string, number or boolean. A metered feature is a metered price, not a feature",
        });
      }
    }
  });

// The Stripe ids are provisioned by auth-service and never supplied by a caller:
// a plan pointed at someone else's Product would have that Product archived on
// deletion. Unknown keys are refused rather than ignored.
const planFields = {
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional().nullable(),
  features: featuresSchema,
  isDefault: z.boolean(),
};

export const createPlanSchema = z
  .object({
    ...planFields,
    features: planFields.features.default({}),
    isDefault: planFields.isDefault.default(false),
  })
  .strict();

// Built from the bare fields: `.partial()` on the create schema would keep its
// defaults, so renaming a plan would silently reset its features and default flag.
export const updatePlanSchema = z.object(planFields).partial().strict();

/**
 * A plan price is either `fixed` (a recurring or one-off amount) or `metered`
 * (a per-unit price backed by a meter, with a hard cap). A metered row must
 * carry its feature key, unit and cap, and may not be one-off.
 */
export const createPlanPriceSchema = z
  .object({
    name: z.string().min(1).max(64),
    amount: z.number().int().min(0), // smallest currency unit (e.g. cents)
    currency: z.string().length(3).default("usd"),
    interval: z.enum(["month", "year", "one_time"]).default("month"),
    billingType: z.enum(["fixed", "metered"]).default("fixed"),
    featureKey: z
      .string()
      .min(1)
      .max(64)
      .regex(FEATURE_KEY_RE, "featureKey must be alphanumeric with dots")
      .optional()
      .nullable(),
    unit: z.string().min(1).max(32).optional().nullable(),
    // -1 = unlimited; a metered price must always carry a cap.
    usageLimit: z.number().int().min(-1).optional().nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.billingType === "metered") {
      if (!v.featureKey) {
        ctx.addIssue({
          code: "custom",
          path: ["featureKey"],
          message: "featureKey is required for a metered price",
        });
      }
      if (!v.unit) {
        ctx.addIssue({
          code: "custom",
          path: ["unit"],
          message: "unit is required for a metered price",
        });
      }
      if (v.usageLimit === undefined || v.usageLimit === null) {
        ctx.addIssue({
          code: "custom",
          path: ["usageLimit"],
          message:
            "usageLimit is required for a metered price (-1 = unlimited)",
        });
      }
      if (v.interval === "one_time") {
        ctx.addIssue({
          code: "custom",
          path: ["interval"],
          message: "a metered price cannot be one-off",
        });
      }
      return;
    }
    if (
      v.featureKey ||
      v.unit ||
      (v.usageLimit !== undefined && v.usageLimit !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "featureKey, unit and usageLimit are only valid for a metered price",
      });
    }
  });

/**
 * Update the mutable parts of a price. Amount, currency, interval and the
 * feature key are immutable in Stripe (a change archives the price and creates
 * a new one), so they are not editable here.
 */
export const updatePlanPriceSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    unit: z.string().min(1).max(32).optional(),
    usageLimit: z.number().int().min(-1).optional(),
  })
  .strict();

export interface AppRow {
  id: string;
  name: string;
  slug: string;
}

export async function ensureApp(appId: string): Promise<AppRow> {
  const [app] = await db
    .select({
      id: applications.id,
      name: applications.name,
      slug: applications.slug,
    })
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  if (!app) throw ERR.APP_002();
  return app;
}

export interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  stripeProductId: string | null;
}

export async function ensurePlan(
  appId: string,
  planId: string,
): Promise<PlanRow> {
  const [plan] = await db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      description: subscriptionPlans.description,
      stripeProductId: subscriptionPlans.stripeProductId,
    })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.id, planId),
        eq(subscriptionPlans.applicationId, appId),
      ),
    )
    .limit(1);
  if (!plan) throw ERR.SUB_001();
  return plan;
}
