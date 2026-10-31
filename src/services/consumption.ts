import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  consumptionAggregates,
  consumptionEntries,
  userApplications,
} from "../db/schema.js";
import { ERR } from "../errors.js";
import { recordMeteredUsage } from "./billing/usage.js";

const CONSUMPTION_KEY_RE = /^[a-zA-Z0-9.]+$/;

export const consumptionKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(CONSUMPTION_KEY_RE, "key must be alphanumeric with dots");

export const consumptionReportSchema = z.object({
  key: consumptionKeySchema,
  value: z.number().finite("value must be a finite number"),
  // Optional retry key: the same key reported twice increments usage once.
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

/**
 * Parse a report body, mapping a bad key or value to its dedicated error code
 * so every caller of the consumption API sees the same contract.
 */
export function parseConsumptionReport<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const { issues } = parsed.error;
  const keyIssue = issues.find((i) => i.path.includes("key"));
  const valueIssue = issues.find((i) => i.path.includes("value"));
  if (keyIssue) throw ERR.CONS_001(keyIssue.message);
  if (valueIssue) throw ERR.CONS_002(valueIssue.message);
  throw ERR.APP_001("Invalid consumption data", parsed.error.flatten());
}

export interface ConsumptionAggregateView {
  key: string;
  total: string;
}

export interface ConsumptionReportResult {
  metered: boolean;
  aggregate: ConsumptionAggregateView;
}

/** Response body of a report: `metered` only appears for Stripe-metered keys. */
export function toReportResponse(result: ConsumptionReportResult): {
  success: true;
  metered?: true;
  aggregate: ConsumptionAggregateView;
} {
  return result.metered
    ? { success: true, metered: true, aggregate: result.aggregate }
    : { success: true, aggregate: result.aggregate };
}

export async function recordConsumption(input: {
  userId: string;
  applicationId: string;
  key: string;
  value: number;
  idempotencyKey?: string | undefined;
}): Promise<ConsumptionReportResult> {
  const { userId, applicationId, key, value } = input;

  const [access] = await db
    .select({ id: userApplications.id })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, userId),
        eq(userApplications.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!access) throw ERR.CONS_003();

  // A key that prices a metered feature of the user's active plan is billed
  // through Stripe meters (hard cap enforced) instead of the free counters.
  const metered = await recordMeteredUsage({
    userId,
    applicationId,
    key,
    value,
    idempotencyKey: input.idempotencyKey,
  });
  if (metered) return { metered: true, aggregate: metered };

  // The raw entry and the running total move together or not at all.
  const [aggregate] = await db.transaction(async (tx) => {
    await tx.insert(consumptionEntries).values({
      userId,
      applicationId,
      key,
      value: String(value),
    });

    // Increment the total by value, supporting negative credits.
    return tx
      .insert(consumptionAggregates)
      .values({
        userId,
        applicationId,
        key,
        total: String(value),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          consumptionAggregates.userId,
          consumptionAggregates.applicationId,
          consumptionAggregates.key,
        ],
        set: {
          total: sql`${consumptionAggregates.total} + ${String(value)}`,
          updatedAt: new Date(),
        },
      })
      .returning({
        key: consumptionAggregates.key,
        total: consumptionAggregates.total,
      });
  });
  return { metered: false, aggregate };
}

export async function listConsumption(userId: string, applicationId: string) {
  return db
    .select({
      key: consumptionAggregates.key,
      total: consumptionAggregates.total,
      updatedAt: consumptionAggregates.updatedAt,
    })
    .from(consumptionAggregates)
    .where(
      and(
        eq(consumptionAggregates.userId, userId),
        eq(consumptionAggregates.applicationId, applicationId),
      ),
    );
}

export async function getConsumption(
  userId: string,
  applicationId: string,
  key: string,
) {
  const [row] = await db
    .select({
      key: consumptionAggregates.key,
      total: consumptionAggregates.total,
      updatedAt: consumptionAggregates.updatedAt,
    })
    .from(consumptionAggregates)
    .where(
      and(
        eq(consumptionAggregates.userId, userId),
        eq(consumptionAggregates.applicationId, applicationId),
        eq(consumptionAggregates.key, key),
      ),
    )
    .limit(1);
  if (!row) throw ERR.CONS_003("Consumption record not found");
  return row;
}
