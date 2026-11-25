import {
  and,
  count,
  desc,
  eq,
  gte,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../../db/index.js";
import { user as userTable } from "../../db/auth-schema.js";
import {
  resourceAccessEvents,
  resourceUsageRecords,
} from "../../db/resource-schema.js";
import {
  denseDailySeries,
  rangeStart,
  rangeToDays,
  type StatsRange,
} from "../daily-series.js";
import type { ResourceEventDecision } from "./types.js";

export interface DecisionSeriesPoint {
  date: string;
  allow: number;
  deny: number;
}

export interface SecurityStats {
  range: StatsRange;
  generatedAt: string;
  resources: {
    total: number;
    byStatus: { status: string; count: number }[];
    byScheme: { scheme: string; count: number }[];
  };
  grants: {
    active: number;
    expiringSoon: number;
    everyone: number;
    bySubjectType: { subjectType: string; count: number }[];
  };
  invitations: { pending: number };
  access: {
    allow: number;
    deny: number;
    series: DecisionSeriesPoint[];
    bySource: { source: string; allow: number; deny: number }[];
    topDeniedReasons: { reason: string; count: number }[];
    topResources: {
      uri: string;
      scheme: string;
      calls: number;
      denies: number;
    }[];
    topSubjects: {
      subjectId: string;
      name: string | null;
      email: string | null;
      calls: number;
      denies: number;
    }[];
  };
}

// Raw aggregates via sql`` because date_trunc and FILTER are not exposed by the
// typed builder; every interpolated value is server-controlled or bound.
async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

export async function getSecurityStats(
  range: StatsRange,
  now: Date = new Date(),
): Promise<SecurityStats> {
  const days = rangeToDays(range);
  const since = rangeStart(days, now).toISOString();

  const [
    byStatus,
    byScheme,
    grantTotals,
    grantTypes,
    invitationRows,
    seriesRows,
    sourceRows,
    reasonRows,
    resourceRows,
    subjectRows,
  ] = await Promise.all([
    rows<{ status: string; count: number }>(
      sql`SELECT status, COUNT(*)::int AS count FROM resources GROUP BY status ORDER BY count DESC`,
    ),
    rows<{ scheme: string; count: number }>(
      sql`SELECT scheme, COUNT(*)::int AS count FROM resources WHERE status <> 'disabled' GROUP BY scheme ORDER BY count DESC`,
    ),
    rows<{ active: number; expiring: number; everyone: number }>(
      sql`SELECT COUNT(*)::int AS active,
                 COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}::timestamptz + interval '7 days')::int AS expiring,
                 COUNT(*) FILTER (WHERE subject_type = 'everyone')::int AS everyone
          FROM resource_grants
          WHERE revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)`,
    ),
    rows<{ subjectType: string; count: number }>(
      sql`SELECT subject_type AS "subjectType", COUNT(*)::int AS count
          FROM resource_grants
          WHERE revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)
          GROUP BY subject_type ORDER BY count DESC`,
    ),
    rows<{ pending: number }>(
      sql`SELECT COUNT(*)::int AS pending FROM resource_invitations
          WHERE consumed_at IS NULL AND revoked_at IS NULL
            AND expires_at > ${now.toISOString()}::timestamptz`,
    ),
    rows<{ day: string; allow: number; deny: number }>(
      sql`SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                 COUNT(*) FILTER (WHERE decision = 'allow')::int AS allow,
                 COUNT(*) FILTER (WHERE decision = 'deny')::int AS deny
          FROM resource_access_events
          WHERE occurred_at >= ${since}::timestamptz
          GROUP BY day ORDER BY day ASC`,
    ),
    rows<{ source: string; allow: number; deny: number }>(
      sql`SELECT source,
                 COUNT(*) FILTER (WHERE decision = 'allow')::int AS allow,
                 COUNT(*) FILTER (WHERE decision = 'deny')::int AS deny
          FROM resource_access_events
          WHERE occurred_at >= ${since}::timestamptz
          GROUP BY source ORDER BY (COUNT(*)) DESC`,
    ),
    rows<{ reason: string | null; count: number }>(
      sql`SELECT reason_class AS reason, COUNT(*)::int AS count
          FROM resource_access_events
          WHERE decision = 'deny' AND occurred_at >= ${since}::timestamptz
          GROUP BY reason_class ORDER BY count DESC LIMIT 5`,
    ),
    rows<{ uri: string; scheme: string; calls: number; denies: number }>(
      sql`SELECT uri, scheme, COUNT(*)::int AS calls,
                 COUNT(*) FILTER (WHERE decision = 'deny')::int AS denies
          FROM resource_access_events
          WHERE occurred_at >= ${since}::timestamptz
          GROUP BY uri, scheme ORDER BY calls DESC, uri ASC LIMIT 5`,
    ),
    rows<{
      subjectId: string;
      name: string | null;
      email: string | null;
      calls: number;
      denies: number;
    }>(
      sql`SELECT e.subject_id AS "subjectId", u.name, u.email,
                 COUNT(*)::int AS calls,
                 COUNT(*) FILTER (WHERE e.decision = 'deny')::int AS denies
          FROM resource_access_events e
          LEFT JOIN "user" u ON u.id = e.subject_id
          WHERE e.subject_id IS NOT NULL AND e.occurred_at >= ${since}::timestamptz
          GROUP BY e.subject_id, u.name, u.email
          ORDER BY calls DESC, e.subject_id ASC LIMIT 5`,
    ),
  ]);

  const series = denseDailySeries(
    seriesRows.map((r) => ({
      day: r.day,
      value: { allow: r.allow, deny: r.deny },
    })),
    days,
    { allow: 0, deny: 0 },
    now,
  ).map((p) => ({ date: p.date, ...p.value }));

  return {
    range,
    generatedAt: new Date().toISOString(),
    resources: {
      total: byStatus.reduce((acc, r) => acc + r.count, 0),
      byStatus,
      byScheme,
    },
    grants: {
      active: grantTotals[0]?.active ?? 0,
      expiringSoon: grantTotals[0]?.expiring ?? 0,
      everyone: grantTotals[0]?.everyone ?? 0,
      bySubjectType: grantTypes,
    },
    invitations: { pending: invitationRows[0]?.pending ?? 0 },
    access: {
      allow: series.reduce((acc, p) => acc + p.allow, 0),
      deny: series.reduce((acc, p) => acc + p.deny, 0),
      series,
      bySource: sourceRows,
      topDeniedReasons: reasonRows.map((r) => ({
        reason: r.reason ?? "unspecified",
        count: r.count,
      })),
      topResources: resourceRows,
      topSubjects: subjectRows,
    },
  };
}

export interface AdminAccessEventQuery {
  from?: Date;
  to?: Date;
  decision?: ResourceEventDecision;
  applicationId?: string;
  limit: number;
  offset: number;
}

export async function listAdminAccessEvents(query: AdminAccessEventQuery) {
  const page = await db
    .select({
      id: resourceAccessEvents.id,
      occurredAt: resourceAccessEvents.occurredAt,
      uri: resourceAccessEvents.uri,
      scheme: resourceAccessEvents.scheme,
      subjectId: resourceAccessEvents.subjectId,
      subjectName: userTable.name,
      subjectEmail: userTable.email,
      clientId: resourceAccessEvents.clientId,
      applicationId: resourceAccessEvents.applicationId,
      decision: resourceAccessEvents.decision,
      reasonClass: resourceAccessEvents.reasonClass,
      source: resourceAccessEvents.source,
    })
    .from(resourceAccessEvents)
    .leftJoin(userTable, eq(userTable.id, resourceAccessEvents.subjectId))
    .where(
      and(
        query.from
          ? gte(resourceAccessEvents.occurredAt, query.from)
          : undefined,
        query.to ? lt(resourceAccessEvents.occurredAt, query.to) : undefined,
        query.decision
          ? eq(resourceAccessEvents.decision, query.decision)
          : undefined,
        query.applicationId
          ? eq(resourceAccessEvents.applicationId, query.applicationId)
          : undefined,
      ),
    )
    .orderBy(desc(resourceAccessEvents.occurredAt))
    .limit(query.limit + 1)
    .offset(query.offset);
  const hasMore = page.length > query.limit;
  return {
    events: hasMore ? page.slice(0, query.limit) : page,
    hasMore,
    nextOffset: hasMore ? query.offset + query.limit : null,
  };
}

export interface UserActivity {
  range: StatsRange | "custom";
  from?: string;
  to?: string;
  shared: {
    allow: number;
    deny: number;
    series: DecisionSeriesPoint[];
    topResources: { uri: string; scheme: string; calls: number }[];
    totalTokens: number;
    costUsd: string;
  };
  used: {
    calls: number;
    series: { date: string; calls: number }[];
    topResources: { uri: string; scheme: string; calls: number }[];
    totalTokens: number;
    costUsd: string;
  };
}

/**
 * What other people consumed on the resources a user owns, and what the user
 * consumed themselves, inside one application. Calls come from the usage
 * ledger — not the security access log — so every gateway that reports usage
 * (LLM, SSH, external consumers) is counted consistently. No caller identity
 * is returned: the dashboard only needs counters.
 */
interface ActivityWindow {
  readonly label: StatsRange | "custom";
  readonly days: number;
  readonly since: Date;
  readonly until: Date;
  readonly anchor: Date;
  readonly from?: string;
  readonly to?: string;
}

async function queryUserActivity(
  userId: string,
  applicationId: string,
  window: ActivityWindow,
): Promise<UserActivity> {
  const { days, since, until, anchor } = window;
  const sharedUsageWhere = and(
    eq(resourceUsageRecords.applicationId, applicationId),
    eq(resourceUsageRecords.ownerType, "user"),
    eq(resourceUsageRecords.ownerId, userId),
    ne(resourceUsageRecords.subjectId, userId),
    gte(resourceUsageRecords.occurredAt, since),
    lte(resourceUsageRecords.occurredAt, until),
  );
  const sharedDeniedWhere = and(
    eq(resourceAccessEvents.applicationId, applicationId),
    eq(resourceAccessEvents.ownerType, "user"),
    eq(resourceAccessEvents.ownerId, userId),
    ne(resourceAccessEvents.subjectId, userId),
    eq(resourceAccessEvents.decision, "deny"),
    gte(resourceAccessEvents.occurredAt, since),
    lte(resourceAccessEvents.occurredAt, until),
  );
  const usedWhere = and(
    eq(resourceUsageRecords.applicationId, applicationId),
    eq(resourceUsageRecords.subjectId, userId),
    gte(resourceUsageRecords.occurredAt, since),
    lte(resourceUsageRecords.occurredAt, until),
  );
  const usageDay = sql<string>`to_char(date_trunc('day', ${resourceUsageRecords.occurredAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const accessDay = sql<string>`to_char(date_trunc('day', ${resourceAccessEvents.occurredAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

  const [
    sharedUsageSeries,
    sharedDeniedSeries,
    sharedResources,
    sharedTotals,
    usedSeries,
    usedResources,
    usedTotals,
  ] = await Promise.all([
    db
      .select({ day: usageDay, calls: count() })
      .from(resourceUsageRecords)
      .where(sharedUsageWhere)
      .groupBy(usageDay),
    db
      .select({ day: accessDay, denies: count() })
      .from(resourceAccessEvents)
      .where(sharedDeniedWhere)
      .groupBy(accessDay),
    db
      .select({
        uri: resourceUsageRecords.uri,
        scheme: resourceUsageRecords.scheme,
        calls: count(),
      })
      .from(resourceUsageRecords)
      .where(sharedUsageWhere)
      .groupBy(resourceUsageRecords.uri, resourceUsageRecords.scheme)
      .orderBy(desc(count()), resourceUsageRecords.uri)
      .limit(5),
    db
      .select({
        tokens: sql<string>`coalesce(sum(${resourceUsageRecords.totalTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${resourceUsageRecords.costUsd}), 0)`,
      })
      .from(resourceUsageRecords)
      .where(sharedUsageWhere),
    db
      .select({ day: usageDay, calls: count() })
      .from(resourceUsageRecords)
      .where(usedWhere)
      .groupBy(usageDay),
    db
      .select({
        uri: resourceUsageRecords.uri,
        scheme: resourceUsageRecords.scheme,
        calls: count(),
      })
      .from(resourceUsageRecords)
      .where(usedWhere)
      .groupBy(resourceUsageRecords.uri, resourceUsageRecords.scheme)
      .orderBy(desc(count()), resourceUsageRecords.uri)
      .limit(5),
    db
      .select({
        tokens: sql<string>`coalesce(sum(${resourceUsageRecords.totalTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${resourceUsageRecords.costUsd}), 0)`,
      })
      .from(resourceUsageRecords)
      .where(usedWhere),
  ]);

  const sharedByDay = new Map<string, { allow: number; deny: number }>();
  for (const row of sharedUsageSeries) {
    sharedByDay.set(row.day, { allow: row.calls, deny: 0 });
  }
  for (const row of sharedDeniedSeries) {
    const current = sharedByDay.get(row.day) ?? { allow: 0, deny: 0 };
    sharedByDay.set(row.day, { ...current, deny: row.denies });
  }
  const series = denseDailySeries(
    [...sharedByDay].map(([day, value]) => ({ day, value })),
    days,
    { allow: 0, deny: 0 },
    anchor,
  ).map((p) => ({ date: p.date, ...p.value }));
  const usedDaily = denseDailySeries(
    usedSeries.map((r) => ({ day: r.day, value: r.calls })),
    days,
    0,
    anchor,
  ).map((p) => ({ date: p.date, calls: p.value }));

  return {
    range: window.label,
    ...(window.from === undefined ? {} : { from: window.from }),
    ...(window.to === undefined ? {} : { to: window.to }),
    shared: {
      allow: series.reduce((acc, p) => acc + p.allow, 0),
      deny: series.reduce((acc, p) => acc + p.deny, 0),
      series,
      topResources: sharedResources,
      totalTokens: Number(sharedTotals[0]?.tokens ?? 0),
      costUsd: String(sharedTotals[0]?.cost ?? "0"),
    },
    used: {
      calls: usedDaily.reduce((acc, p) => acc + p.calls, 0),
      series: usedDaily,
      topResources: usedResources,
      totalTokens: Number(usedTotals[0]?.tokens ?? 0),
      costUsd: String(usedTotals[0]?.cost ?? "0"),
    },
  };
}

export async function getUserActivity(
  userId: string,
  applicationId: string,
  range: StatsRange,
  now: Date = new Date(),
): Promise<UserActivity> {
  const days = rangeToDays(range);
  return queryUserActivity(userId, applicationId, {
    label: range,
    days,
    since: rangeStart(days, now),
    until: now,
    anchor: now,
  });
}

/**
 * Same activity over an explicit UTC date window (`YYYY-MM-DD`, inclusive).
 * Reports use it to freeze a closed month; the caller has already bounded the
 * window (max one year, no day in the future).
 */
export async function getUserActivityBetween(
  userId: string,
  applicationId: string,
  from: string,
  to: string,
): Promise<UserActivity> {
  const since = new Date(`${from}T00:00:00.000Z`);
  const anchor = new Date(`${to}T00:00:00.000Z`);
  const days =
    Math.round((anchor.getTime() - since.getTime()) / 86_400_000) + 1;
  const until = new Date(anchor);
  until.setUTCHours(23, 59, 59, 999);
  return queryUserActivity(userId, applicationId, {
    label: "custom",
    days,
    since,
    until,
    anchor,
    from,
    to,
  });
}
