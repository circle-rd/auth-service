import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/index.js";
import {
  sharedResources,
  subscriptionPlans,
  usageRecords,
  userApplications,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";
import type { ResourceType } from "../resource-uri.js";
import { findLatestGrant } from "./grants.js";

export const USAGE_SOURCES = ["provider", "unsupported"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const USAGE_GROUP_BY = ["user", "resource"] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

export type UsageRecord = typeof usageRecords.$inferSelect;

export interface RecordUsageInput {
  subjectId: string;
  clientId: string;
  resourceId: string;
  resourceType: ResourceType;
  resourceKey: string;
  planName: string;
  requestId: string;
  occurredAt: Date;
  usageSource: UsageSource;
  costUsd: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface RecordUsageResult {
  record: UsageRecord;
  replayed: boolean;
}

/** Trim insignificant decimal zeros so a redelivered cost compares equal. */
function normalizeCost(value: string | null): string | null {
  if (value === null) return null;
  const [integer, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${integer}.${trimmed}` : integer;
}

function sameUsageEvent(record: UsageRecord, input: RecordUsageInput): boolean {
  return (
    record.subjectId === input.subjectId &&
    record.clientId === input.clientId &&
    record.resourceType === input.resourceType &&
    record.resourceKey === input.resourceKey &&
    record.requestId === input.requestId &&
    record.usageSource === input.usageSource &&
    record.promptTokens === input.promptTokens &&
    record.completionTokens === input.completionTokens &&
    record.totalTokens === input.totalTokens &&
    normalizeCost(record.costUsd) === normalizeCost(input.costUsd) &&
    record.occurredAt.getTime() === input.occurredAt.getTime()
  );
}

/**
 * Validate that the gateway reported an event that M1 policy could have
 * allowed. The caller is a machine client, so the subject/client are trusted
 * boundaries; ownership, plan and resource identity are derived from the
 * registry, never from the payload.
 */
async function resolveAttribution(input: RecordUsageInput): Promise<{
  ownerApplicationId: string;
  planId: string;
}> {
  const [resource] = await db
    .select({
      id: sharedResources.id,
      ownerApplicationId: sharedResources.ownerApplicationId,
      resourceType: sharedResources.resourceType,
      key: sharedResources.key,
    })
    .from(sharedResources)
    .where(eq(sharedResources.id, input.resourceId))
    .limit(1);
  if (
    !resource ||
    resource.resourceType !== input.resourceType ||
    resource.key !== input.resourceKey
  ) {
    throw ERR.RES_011("Unknown or mismatched resource");
  }

  const [plan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.applicationId, resource.ownerApplicationId),
        eq(subscriptionPlans.name, input.planName),
      ),
    )
    .limit(1);
  if (!plan) throw ERR.RES_011("Unknown or mismatched plan");

  const [membership] = await db
    .select({ id: userApplications.id })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, input.subjectId),
        eq(userApplications.applicationId, resource.ownerApplicationId),
      ),
    )
    .limit(1);
  const grant = await findLatestGrant(
    input.subjectId,
    resource.ownerApplicationId,
    resource.id,
  );

  if (!membership && !grant) {
    throw ERR.RES_011("Subject has no relation to the owner application");
  }
  if (!membership && grant) {
    if (grant.planName !== input.planName) {
      throw ERR.RES_011("Plan does not match the subject's grant");
    }
    if (
      grant.allowedClientIds !== null &&
      !grant.allowedClientIds.includes(input.clientId)
    ) {
      throw ERR.RES_011("Client is not allowed by the subject's grant");
    }
  }

  return { ownerApplicationId: resource.ownerApplicationId, planId: plan.id };
}

/**
 * Persist one gateway usage event. `(resource_id, request_id)` is the
 * idempotency boundary: a redelivery returns the stored row, while a
 * different payload for the same event is a hard conflict instead of a silent
 * overwrite. Distinct provider calls (retries, fallbacks) have distinct
 * gateway-generated request ids and are therefore never collapsed.
 */
export async function recordUsageEvent(
  input: RecordUsageInput,
): Promise<RecordUsageResult> {
  const { ownerApplicationId, planId } = await resolveAttribution(input);

  const [row] = await db
    .insert(usageRecords)
    .values({
      subjectId: input.subjectId,
      clientId: input.clientId,
      ownerApplicationId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      planId,
      requestId: input.requestId,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      costUsd: input.costUsd,
      usageSource: input.usageSource,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({
      target: [usageRecords.resourceId, usageRecords.requestId],
    })
    .returning();
  if (row) return { record: row, replayed: false };

  const [existing] = await db
    .select()
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.resourceId, input.resourceId),
        eq(usageRecords.requestId, input.requestId),
      ),
    )
    .limit(1);
  if (!existing) throw ERR.RES_012("Usage event could not be persisted");
  if (!sameUsageEvent(existing, input)) {
    throw ERR.RES_012("A different payload was already stored for this event");
  }
  return { record: existing, replayed: true };
}

export interface UsageQuery {
  ownerApplicationId: string;
  groupBy: UsageGroupBy;
  from: Date;
  to: Date;
  limit: number;
  offset: number;
}

export interface UsageGroupTotals {
  calls: number;
  /** Calls whose executed attempt exposed no cost or token telemetry. */
  unsupportedCalls: number;
  /** Calls missing at least one token field, including unsupported calls. */
  tokenlessCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: string;
}

export interface UsageUserRow extends UsageGroupTotals {
  subjectId: string;
}

export interface UsageResourceRow extends UsageGroupTotals {
  resourceId: string;
  resourceType: ResourceType;
  resourceKey: string;
  displayName: string | null;
}

export interface OwnerUsageResult {
  groupBy: UsageGroupBy;
  from: string;
  to: string;
  items: UsageUserRow[] | UsageResourceRow[];
  totals: UsageGroupTotals;
  hasMore: boolean;
  nextOffset: number | null;
}

function tokenSum(column: AnyPgColumn) {
  return sql<string>`coalesce(sum(${column}), 0)`;
}

function toNumber(value: string | number | bigint | null): number {
  return value === null ? 0 : Number(value);
}

const totalsSelection = {
  calls: count(),
  unsupportedCalls: sql<string>`count(*) filter (where ${usageRecords.usageSource} = 'unsupported')`,
  tokenlessCalls: sql<string>`count(*) filter (where ${usageRecords.promptTokens} is null or ${usageRecords.completionTokens} is null or ${usageRecords.totalTokens} is null)`,
  promptTokens: tokenSum(usageRecords.promptTokens),
  completionTokens: tokenSum(usageRecords.completionTokens),
  totalTokens: tokenSum(usageRecords.totalTokens),
  costUsd: sql<string>`coalesce(sum(${usageRecords.costUsd}), 0)`,
};

function toTotals(row: {
  calls: number;
  unsupportedCalls: string;
  tokenlessCalls: string;
  promptTokens: string;
  completionTokens: string;
  totalTokens: string;
  costUsd: string;
}): UsageGroupTotals {
  return {
    calls: Number(row.calls),
    unsupportedCalls: toNumber(row.unsupportedCalls),
    tokenlessCalls: toNumber(row.tokenlessCalls),
    promptTokens: toNumber(row.promptTokens),
    completionTokens: toNumber(row.completionTokens),
    totalTokens: toNumber(row.totalTokens),
    costUsd: row.costUsd,
  };
}

/**
 * Owner-scoped aggregation over the gross usage ledger. The owner application
 * id always comes from the delegated guard, never from the request.
 */
export async function getOwnerUsage(
  query: UsageQuery,
): Promise<OwnerUsageResult> {
  const range = and(
    eq(usageRecords.ownerApplicationId, query.ownerApplicationId),
    gte(usageRecords.occurredAt, query.from),
    lt(usageRecords.occurredAt, query.to),
  );

  const [totalsRow] = await db
    .select(totalsSelection)
    .from(usageRecords)
    .where(range);

  if (query.groupBy === "user") {
    const rows = await db
      .select({
        subjectId: usageRecords.subjectId,
        ...totalsSelection,
      })
      .from(usageRecords)
      .where(range)
      .groupBy(usageRecords.subjectId)
      .orderBy(
        desc(sql`sum(${usageRecords.costUsd})`),
        asc(usageRecords.subjectId),
      )
      .limit(query.limit + 1)
      .offset(query.offset);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      subjectId: row.subjectId,
      ...toTotals(row),
    }));
    return {
      groupBy: "user",
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      items,
      totals: toTotals(
        totalsRow ?? {
          calls: 0,
          unsupportedCalls: "0",
          tokenlessCalls: "0",
          promptTokens: "0",
          completionTokens: "0",
          totalTokens: "0",
          costUsd: "0",
        },
      ),
      hasMore,
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  }

  const rows = await db
    .select({
      resourceId: usageRecords.resourceId,
      resourceType: usageRecords.resourceType,
      resourceKey: usageRecords.resourceKey,
      displayName: sharedResources.displayName,
      ...totalsSelection,
    })
    .from(usageRecords)
    .leftJoin(sharedResources, eq(usageRecords.resourceId, sharedResources.id))
    .where(range)
    .groupBy(
      usageRecords.resourceId,
      usageRecords.resourceType,
      usageRecords.resourceKey,
      sharedResources.displayName,
    )
    .orderBy(
      desc(sql`sum(${usageRecords.costUsd})`),
      asc(usageRecords.resourceKey),
    )
    .limit(query.limit + 1)
    .offset(query.offset);
  const hasMore = rows.length > query.limit;
  const items = rows.slice(0, query.limit).map((row) => ({
    resourceId: row.resourceId,
    resourceType: row.resourceType,
    resourceKey: row.resourceKey,
    displayName: row.displayName,
    ...toTotals(row),
  }));
  return {
    groupBy: "resource",
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    items,
    totals: toTotals(
      totalsRow ?? {
        calls: 0,
        unsupportedCalls: "0",
        tokenlessCalls: "0",
        promptTokens: "0",
        completionTokens: "0",
        totalTokens: "0",
        costUsd: "0",
      },
    ),
    hasMore,
    nextOffset: hasMore ? query.offset + query.limit : null,
  };
}
