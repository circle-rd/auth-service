import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import {
  resourceAccessEvents,
  resourceUsageRecords,
  resources as resourcesTable,
} from "../../db/resource-schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { ERR } from "../../errors.js";
import { logger } from "../../logger.js";
import { evaluateResourceAccess } from "./policy.js";
import { getResource } from "./registry.js";
import type {
  ResourceEventDecision,
  ResourceEventSource,
  ResourceOwnerType,
  ResourceSubjectType,
  ResourceUsageSource,
} from "./types.js";

export const USAGE_GROUP_BY = ["user", "resource"] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

export type ResourceUsageRow = typeof resourceUsageRecords.$inferSelect;

export interface RecordAccessEventInput {
  resourceId?: string | null;
  uri: string;
  scheme: string;
  ownerType?: ResourceOwnerType | null;
  ownerId?: string | null;
  subjectType?: ResourceSubjectType | null;
  subjectId?: string | null;
  actorUserId?: string | null;
  clientId: string;
  applicationId?: string | null;
  decision: ResourceEventDecision;
  reasonClass?: string | null;
  requestId?: string | null;
  source: ResourceEventSource;
  metadata?: Record<string, unknown>;
}

export async function recordAccessEvent(
  input: RecordAccessEventInput,
): Promise<void> {
  await db.insert(resourceAccessEvents).values({
    resourceId: input.resourceId ?? null,
    uri: input.uri.slice(0, 512),
    scheme: input.scheme.slice(0, 50),
    ownerType: input.ownerType ?? null,
    ownerId: input.ownerId ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    actorUserId: input.actorUserId ?? null,
    clientId: input.clientId.slice(0, 256),
    applicationId: input.applicationId ?? null,
    decision: input.decision,
    reasonClass: input.reasonClass ?? null,
    requestId: input.requestId?.slice(0, 256) ?? null,
    source: input.source,
    metadata: input.metadata ?? {},
  });
}

export interface RecordUsageInput {
  subjectId: string;
  clientId: string;
  resourceId: string;
  resourceUri: string;
  requestId: string;
  occurredAt: Date;
  usageSource: ResourceUsageSource;
  costUsd: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface RecordUsageResult {
  record: ResourceUsageRow;
  replayed: boolean;
}

function normalizeCost(value: string | null): string | null {
  if (value === null) return null;
  const [integer, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${integer}.${trimmed}` : integer;
}

function sameUsageEvent(
  record: ResourceUsageRow,
  input: RecordUsageInput,
): boolean {
  return (
    record.subjectId === input.subjectId &&
    record.clientId === input.clientId &&
    record.uri === input.resourceUri &&
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
 * Persist one gateway usage event. The gateway already authorized the call;
 * this re-checks the resource identity and the subject's current relation so a
 * machine client cannot attribute usage to an unrelated subject.
 */
export async function recordUsageEvent(
  input: RecordUsageInput,
): Promise<RecordUsageResult> {
  // Check idempotency first: a retry of a stored event must succeed even if
  // access was revoked after the original delivery.
  const [existingEvent] = await db
    .select()
    .from(resourceUsageRecords)
    .where(
      and(
        eq(resourceUsageRecords.requestId, input.requestId),
        or(
          eq(resourceUsageRecords.resourceId, input.resourceId),
          and(
            isNull(resourceUsageRecords.resourceId),
            eq(resourceUsageRecords.uri, input.resourceUri),
          ),
        ),
      ),
    )
    .limit(1);
  if (existingEvent) {
    if (!sameUsageEvent(existingEvent, input)) {
      throw ERR.RES_012(
        "A different payload was already stored for this event",
      );
    }
    return { record: existingEvent, replayed: true };
  }

  const resource = await getResource(input.resourceId);
  if (resource.uri !== input.resourceUri) {
    throw ERR.RES_011("Unknown or mismatched resource");
  }
  const access = await evaluateResourceAccess({
    resource,
    subjectId: input.subjectId,
  });
  if (access.decision !== "allow") {
    throw ERR.RES_011("Subject has no active access to this resource");
  }

  const [row] = await db
    .insert(resourceUsageRecords)
    .values({
      occurredAt: input.occurredAt,
      resourceId: resource.id,
      uri: resource.uri,
      scheme: resource.scheme,
      ownerType: resource.ownerType,
      ownerId: resource.ownerId,
      subjectType: "user",
      subjectId: input.subjectId,
      clientId: input.clientId,
      applicationId: resource.applicationId,
      requestId: input.requestId,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      costUsd: input.costUsd,
      usageSource: input.usageSource,
    })
    .onConflictDoNothing({
      target: [resourceUsageRecords.resourceId, resourceUsageRecords.requestId],
    })
    .returning();
  if (row) return { record: row, replayed: false };

  const [existing] = await db
    .select()
    .from(resourceUsageRecords)
    .where(
      and(
        eq(resourceUsageRecords.resourceId, input.resourceId),
        eq(resourceUsageRecords.requestId, input.requestId),
      ),
    )
    .limit(1);
  if (!existing) throw ERR.RES_012("Usage event could not be persisted");
  if (!sameUsageEvent(existing, input)) {
    throw ERR.RES_012("A different payload was already stored for this event");
  }
  return { record: existing, replayed: true };
}

export interface AccessEventView {
  id: string;
  occurredAt: Date;
  resourceId: string | null;
  uri: string;
  scheme: string;
  ownerType: ResourceOwnerType | null;
  ownerId: string | null;
  subjectType: ResourceSubjectType | null;
  subjectId: string | null;
  actorUserId: string | null;
  clientId: string;
  applicationId: string | null;
  decision: ResourceEventDecision;
  reasonClass: string | null;
  requestId: string | null;
  source: ResourceEventSource;
}

export interface AccessEventQuery {
  applicationId: string;
  from?: Date;
  to?: Date;
  decision?: ResourceEventDecision;
  limit: number;
  offset: number;
}

export async function listAccessEvents(
  query: AccessEventQuery,
): Promise<AccessEventView[]> {
  return db
    .select({
      id: resourceAccessEvents.id,
      occurredAt: resourceAccessEvents.occurredAt,
      resourceId: resourceAccessEvents.resourceId,
      uri: resourceAccessEvents.uri,
      scheme: resourceAccessEvents.scheme,
      ownerType: resourceAccessEvents.ownerType,
      ownerId: resourceAccessEvents.ownerId,
      subjectType: resourceAccessEvents.subjectType,
      subjectId: resourceAccessEvents.subjectId,
      actorUserId: resourceAccessEvents.actorUserId,
      clientId: resourceAccessEvents.clientId,
      applicationId: resourceAccessEvents.applicationId,
      decision: resourceAccessEvents.decision,
      reasonClass: resourceAccessEvents.reasonClass,
      requestId: resourceAccessEvents.requestId,
      source: resourceAccessEvents.source,
    })
    .from(resourceAccessEvents)
    .where(
      and(
        eq(resourceAccessEvents.applicationId, query.applicationId),
        query.from
          ? gte(resourceAccessEvents.occurredAt, query.from)
          : undefined,
        query.to ? lt(resourceAccessEvents.occurredAt, query.to) : undefined,
        query.decision
          ? eq(resourceAccessEvents.decision, query.decision)
          : undefined,
      ),
    )
    .orderBy(desc(resourceAccessEvents.occurredAt))
    .limit(query.limit)
    .offset(query.offset);
}

export interface UsageQuery {
  groupBy: UsageGroupBy;
  from: Date;
  to: Date;
  limit: number;
  offset: number;
}

export interface UsageGroupTotals {
  calls: number;
  unsupportedCalls: number;
  tokenlessCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: string;
}

export interface UsageUserRow extends UsageGroupTotals {
  subjectId: string;
  // Name or e-mail; null when the user no longer exists.
  subjectLabel: string | null;
}

export interface UsageResourceRow extends UsageGroupTotals {
  resourceId: string;
  uri: string;
  scheme: string;
  displayName: string | null;
}

export interface UsageResult {
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
  unsupportedCalls: sql<string>`count(*) filter (where ${resourceUsageRecords.usageSource} = 'unsupported')`,
  tokenlessCalls: sql<string>`count(*) filter (where ${resourceUsageRecords.promptTokens} is null or ${resourceUsageRecords.completionTokens} is null or ${resourceUsageRecords.totalTokens} is null)`,
  promptTokens: tokenSum(resourceUsageRecords.promptTokens),
  completionTokens: tokenSum(resourceUsageRecords.completionTokens),
  totalTokens: tokenSum(resourceUsageRecords.totalTokens),
  costUsd: sql<string>`coalesce(sum(${resourceUsageRecords.costUsd}), 0)`,
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

const EMPTY_TOTALS = {
  calls: 0,
  unsupportedCalls: "0",
  tokenlessCalls: "0",
  promptTokens: "0",
  completionTokens: "0",
  totalTokens: "0",
  costUsd: "0",
} as const;

async function queryUsage(
  scope: SQL | undefined,
  query: UsageQuery,
): Promise<UsageResult> {
  const range = and(
    scope,
    gte(resourceUsageRecords.occurredAt, query.from),
    lt(resourceUsageRecords.occurredAt, query.to),
  );

  const [totalsRow] = await db
    .select(totalsSelection)
    .from(resourceUsageRecords)
    .where(range);

  if (query.groupBy === "user") {
    const rows = await db
      .select({
        subjectId: resourceUsageRecords.subjectId,
        ...totalsSelection,
      })
      .from(resourceUsageRecords)
      .where(range)
      .groupBy(resourceUsageRecords.subjectId)
      .orderBy(
        desc(sql`coalesce(sum(${resourceUsageRecords.costUsd}), 0)`),
        asc(resourceUsageRecords.subjectId),
      )
      .limit(query.limit + 1)
      .offset(query.offset);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const subjectIds = [
      ...new Set(
        page.map((row) => row.subjectId).filter((id): id is string => !!id),
      ),
    ];
    const users =
      subjectIds.length > 0
        ? await db
            .select({
              id: userTable.id,
              name: userTable.name,
              email: userTable.email,
            })
            .from(userTable)
            .where(inArray(userTable.id, subjectIds))
        : [];
    const labels = new Map(
      users.map((user) => [user.id, user.name || user.email || user.id]),
    );
    return {
      groupBy: "user",
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      items: page.map((row) => ({
        subjectId: row.subjectId ?? "",
        subjectLabel: row.subjectId
          ? (labels.get(row.subjectId) ?? null)
          : null,
        ...toTotals(row),
      })),
      totals: toTotals(totalsRow ?? EMPTY_TOTALS),
      hasMore,
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  }

  const rows = await db
    .select({
      resourceId: resourceUsageRecords.resourceId,
      uri: resourceUsageRecords.uri,
      scheme: resourceUsageRecords.scheme,
      displayName: resourcesTable.displayName,
      ...totalsSelection,
    })
    .from(resourceUsageRecords)
    .leftJoin(
      resourcesTable,
      eq(resourceUsageRecords.resourceId, resourcesTable.id),
    )
    .where(range)
    .groupBy(
      resourceUsageRecords.resourceId,
      resourceUsageRecords.uri,
      resourceUsageRecords.scheme,
      resourcesTable.displayName,
    )
    .orderBy(
      desc(sql`coalesce(sum(${resourceUsageRecords.costUsd}), 0)`),
      asc(resourceUsageRecords.uri),
    )
    .limit(query.limit + 1)
    .offset(query.offset);
  const hasMore = rows.length > query.limit;
  return {
    groupBy: "resource",
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    items: rows.slice(0, query.limit).map((row) => ({
      // Deleted resources keep their usage; fall back to the URI as the key.
      resourceId: row.resourceId ?? row.uri,
      uri: row.uri,
      scheme: row.scheme,
      displayName: row.displayName,
      ...toTotals(row),
    })),
    totals: toTotals(totalsRow ?? EMPTY_TOTALS),
    hasMore,
    nextOffset: hasMore ? query.offset + query.limit : null,
  };
}

export async function getApplicationUsage(
  applicationId: string,
  query: UsageQuery,
): Promise<UsageResult> {
  return queryUsage(
    eq(resourceUsageRecords.applicationId, applicationId),
    query,
  );
}

/** Delete monitoring rows past their configured retention. */
export async function sweepResourceMonitoringRetention(
  now: Date = new Date(),
): Promise<{ accessEvents: number; usageRecords: number }> {
  const accessCutoff = new Date(
    now.getTime() - config.resources.accessEventRetentionDays * 86_400_000,
  );
  const usageCutoff = new Date(
    now.getTime() - config.resources.usageRecordRetentionDays * 86_400_000,
  );
  const deletedAccess = await db
    .delete(resourceAccessEvents)
    .where(lt(resourceAccessEvents.occurredAt, accessCutoff))
    .returning({ id: resourceAccessEvents.id });
  const deletedUsage = await db
    .delete(resourceUsageRecords)
    .where(lt(resourceUsageRecords.occurredAt, usageCutoff))
    .returning({ id: resourceUsageRecords.id });
  if (deletedAccess.length > 0 || deletedUsage.length > 0) {
    logger.info(
      {
        accessEvents: deletedAccess.length,
        usageRecords: deletedUsage.length,
      },
      "[res] monitoring retention sweep",
    );
  }
  return {
    accessEvents: deletedAccess.length,
    usageRecords: deletedUsage.length,
  };
}

/** Daily retention sweep; kept in-process because the tables are small. */
export function startResourceMonitoringRetention(): void {
  if (!config.features.resourceSharing) return;
  const run = () => {
    void sweepResourceMonitoringRetention().catch((err: unknown) => {
      logger.warn({ err }, "[res] monitoring retention sweep failed");
    });
  };
  run();
  const timer = setInterval(
    run,
    config.resources.retentionSweepHours * 3_600_000,
  );
  timer.unref();
}
