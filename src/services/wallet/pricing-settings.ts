import { desc, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import { walletPricingSettings } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import type { PricingChange, PricingSettings, UsdPricing } from "./types.js";

const columns = {
  id: walletPricingSettings.id,
  usdToEurRate: walletPricingSettings.usdToEurRate,
  marginPercent: walletPricingSettings.marginPercent,
  reason: walletPricingSettings.reason,
  createdAt: walletPricingSettings.createdAt,
  actorId: walletPricingSettings.actorUserId,
  actorName: user.name,
};

function toChange(row: {
  id: string;
  usdToEurRate: string;
  marginPercent: number;
  reason: string;
  createdAt: Date;
  actorId: string;
  actorName: string | null;
}): PricingChange {
  return {
    id: row.id,
    usdToEurRate: row.usdToEurRate,
    marginPercent: row.marginPercent,
    reason: row.reason,
    createdAt: row.createdAt,
    actor: { id: row.actorId, name: row.actorName },
  };
}

/**
 * The pricing in force: the newest saved change, or the environment values until
 * an administrator saves one. Null when neither exists.
 */
export async function getPricingSettings(): Promise<PricingSettings | null> {
  const [row] = await db
    .select(columns)
    .from(walletPricingSettings)
    .leftJoin(user, eq(user.id, walletPricingSettings.actorUserId))
    .orderBy(desc(walletPricingSettings.createdAt))
    .limit(1);
  if (row) {
    const change = toChange(row);
    return {
      usdToEurRate: change.usdToEurRate,
      marginPercent: change.marginPercent,
      source: "database",
      change,
    };
  }
  const { usdToEurRate, marginPercent } = config.wallet;
  if (!usdToEurRate) return null;
  return { usdToEurRate, marginPercent, source: "environment", change: null };
}

/** Pricing for a debit, or a 503 when nobody has set the exchange rate yet. */
export async function getUsdPricing(): Promise<UsdPricing> {
  const settings = await getPricingSettings();
  if (!settings) throw ERR.WAL_007();
  return {
    usdToEurRate: settings.usdToEurRate,
    marginPercent: settings.marginPercent,
  };
}

export interface UpdatePricingInput extends UsdPricing {
  actorId: string;
  reason: string;
}

/** Save new pricing. It applies to the next debit; charges already made are untouched. */
export async function updatePricingSettings(
  input: UpdatePricingInput,
): Promise<PricingChange> {
  const [inserted] = await db
    .insert(walletPricingSettings)
    .values({
      usdToEurRate: input.usdToEurRate,
      marginPercent: input.marginPercent,
      actorUserId: input.actorId,
      reason: input.reason,
    })
    .returning({ id: walletPricingSettings.id });
  if (!inserted) throw ERR.WAL_007("Pricing could not be saved");
  const [row] = await db
    .select(columns)
    .from(walletPricingSettings)
    .leftJoin(user, eq(user.id, walletPricingSettings.actorUserId))
    .where(eq(walletPricingSettings.id, inserted.id))
    .limit(1);
  if (!row) throw ERR.WAL_007("Pricing could not be saved");
  return toChange(row);
}

export const PRICING_HISTORY_LIMIT = 20;

/** The latest changes, newest first. */
export async function listPricingHistory(
  limit = PRICING_HISTORY_LIMIT,
): Promise<PricingChange[]> {
  const rows = await db
    .select(columns)
    .from(walletPricingSettings)
    .leftJoin(user, eq(user.id, walletPricingSettings.actorUserId))
    .orderBy(desc(walletPricingSettings.createdAt))
    .limit(limit);
  return rows.map(toChange);
}
