import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import { walletAccounts, walletTransactions } from "../../db/schema.js";
import type {
  AdminWalletStats,
  UserSpendStats,
  WalletBreakdownEntry,
  WalletDailyPoint,
  WalletKindEntry,
  WalletListFilter,
  WalletListItem,
  WalletTopConsumer,
} from "./types.js";

// Aggregates use `sql` templates because `date_trunc` and conditional sums are
// not exposed by the typed builder; every value is bound, never concatenated.

const TOP_CONSUMERS = 5;
const BREAKDOWN_LIMIT = 8;

function startOfWindow(days: number): Date {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

/** Zero-filled daily series, so a chart needs no interpolation. */
function denseSeries(
  rows: { day: string; amount: string; count: number }[],
  days: number,
): WalletDailyPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: WalletDailyPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const row = byDay.get(date);
    out.push({ date, amount: row?.amount ?? "0", count: row?.count ?? 0 });
  }
  return out;
}

function sumAmounts(series: { amount: string; count: number }[]): {
  total: string;
  count: number;
} {
  return {
    total: series.reduce((sum, p) => sum + BigInt(p.amount), 0n).toString(),
    count: series.reduce((sum, p) => sum + p.count, 0),
  };
}

/** Rows of the given ledger type, optionally limited to one account. */
function ledgerFilter(
  type: "usage" | "topup",
  since: Date,
  accountId?: string,
): SQL {
  return sql`t.type = ${type}
    AND t.created_at >= ${since.toISOString()}::timestamptz
    ${accountId ? sql`AND t.account_id = ${accountId}::uuid` : sql``}`;
}

async function dailySeries(
  type: "usage" | "topup",
  days: number,
  accountId?: string,
): Promise<WalletDailyPoint[]> {
  const sign = type === "usage" ? sql`-SUM(t.amount)` : sql`SUM(t.amount)`;
  const rows = (await db.execute(
    sql`SELECT to_char(date_trunc('day', t.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               (${sign})::text AS amount,
               COUNT(*)::int AS count
        FROM wallet_transactions t
        WHERE ${ledgerFilter(type, startOfWindow(days), accountId)}
        GROUP BY day`,
  )) as unknown as { day: string; amount: string; count: number }[];
  return denseSeries(rows, days);
}

async function byApplication(
  days: number,
  accountId?: string,
): Promise<WalletBreakdownEntry[]> {
  const rows = (await db.execute(
    sql`SELECT t.application_id AS "applicationId",
               COALESCE(a.name, t.metadata->>'applicationSlug') AS name,
               COALESCE(a.slug, t.metadata->>'applicationSlug') AS slug,
               (-SUM(t.amount))::text AS amount,
               COUNT(*)::int AS count
        FROM wallet_transactions t
        LEFT JOIN applications a ON a.id = t.application_id
        WHERE ${ledgerFilter("usage", startOfWindow(days), accountId)}
        GROUP BY t.application_id, a.name, a.slug, t.metadata->>'applicationSlug'
        ORDER BY SUM(t.amount) ASC
        LIMIT ${BREAKDOWN_LIMIT}`,
  )) as unknown as WalletBreakdownEntry[];
  return rows;
}

async function byKind(
  days: number,
  accountId?: string,
): Promise<WalletKindEntry[]> {
  return (await db.execute(
    sql`SELECT COALESCE(t.metadata->>'kind', 'other') AS kind,
               (-SUM(t.amount))::text AS amount,
               COUNT(*)::int AS count
        FROM wallet_transactions t
        WHERE ${ledgerFilter("usage", startOfWindow(days), accountId)}
        GROUP BY kind
        ORDER BY SUM(t.amount) ASC`,
  )) as unknown as WalletKindEntry[];
}

/** What one wallet spent over the last `days` days (UTC). */
export async function getUserSpendStats(
  accountId: string,
  days: number,
): Promise<UserSpendStats> {
  const [series, applications, kinds] = await Promise.all([
    dailySeries("usage", days, accountId),
    byApplication(days, accountId),
    byKind(days, accountId),
  ]);
  const { total, count } = sumAmounts(series);
  return {
    days,
    total,
    calls: count,
    series,
    byApplication: applications,
    byKind: kinds,
  };
}

/** Platform-wide wallet figures for the admin dashboard. */
export async function getAdminWalletStats(
  days: number,
): Promise<AdminWalletStats> {
  const [totalsRows, spendSeries, topUpSeries, topRows, applications, kinds] =
    await Promise.all([
      db.execute(
        sql`SELECT COUNT(*)::int AS accounts,
                   COUNT(*) FILTER (WHERE balance < 0)::int AS "accountsInDebt",
                   COUNT(*) FILTER (WHERE is_unlimited)::int AS "unlimitedAccounts",
                   COALESCE(SUM(balance) FILTER (WHERE balance > 0 AND NOT is_unlimited), 0)::text AS "outstandingCredit",
                   COALESCE(-SUM(balance) FILTER (WHERE balance < 0), 0)::text AS "outstandingDebt"
            FROM wallet_accounts`,
      ),
      dailySeries("usage", days),
      dailySeries("topup", days),
      db.execute(
        sql`SELECT a.owner_type AS "ownerType", a.owner_id AS "ownerId",
                   u.name AS name, u.email AS email,
                   (-SUM(t.amount))::text AS amount, COUNT(*)::int AS count
            FROM wallet_transactions t
            JOIN wallet_accounts a ON a.id = t.account_id
            LEFT JOIN "user" u ON a.owner_type = 'user' AND u.id = a.owner_id
            WHERE ${ledgerFilter("usage", startOfWindow(days))}
            GROUP BY a.owner_type, a.owner_id, u.name, u.email
            ORDER BY SUM(t.amount) ASC
            LIMIT ${TOP_CONSUMERS}`,
      ),
      byApplication(days),
      byKind(days),
    ]);

  const spend = sumAmounts(spendSeries);
  const topUps = sumAmounts(topUpSeries);
  return {
    days,
    totals: (totalsRows as unknown as AdminWalletStats["totals"][])[0]!,
    spend: { total: spend.total, calls: spend.count, series: spendSeries },
    topUps: { total: topUps.total, count: topUps.count, series: topUpSeries },
    topConsumers: topRows as unknown as WalletTopConsumer[],
    byApplication: applications,
    byKind: kinds,
  };
}

export interface ListWalletsInput {
  page: number;
  limit: number;
  search?: string;
  filter: WalletListFilter;
}

/** LIKE wildcards typed by an administrator are searched for literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listWalletAccounts(
  input: ListWalletsInput,
): Promise<{ wallets: WalletListItem[]; total: number }> {
  const conditions: (SQL | undefined)[] = [];
  if (input.filter === "debt") conditions.push(lt(walletAccounts.balance, 0n));
  if (input.filter === "credit") {
    conditions.push(
      and(
        gte(walletAccounts.balance, 1n),
        eq(walletAccounts.isUnlimited, false),
      ),
    );
  }
  if (input.filter === "unlimited")
    conditions.push(eq(walletAccounts.isUnlimited, true));
  if (input.search) {
    const pattern = `%${escapeLike(input.search)}%`;
    conditions.push(
      or(
        ilike(user.email, pattern),
        ilike(user.name, pattern),
        ilike(walletAccounts.ownerId, pattern),
      ),
    );
  }
  const where = and(...conditions);

  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: walletAccounts.id,
        ownerType: walletAccounts.ownerType,
        ownerId: walletAccounts.ownerId,
        name: user.name,
        email: user.email,
        balance: walletAccounts.balance,
        isUnlimited: walletAccounts.isUnlimited,
        updatedAt: walletAccounts.updatedAt,
      })
      .from(walletAccounts)
      .leftJoin(
        user,
        and(
          eq(walletAccounts.ownerType, "user"),
          eq(user.id, walletAccounts.ownerId),
        ),
      )
      .where(where)
      .orderBy(
        input.filter === "debt"
          ? walletAccounts.balance
          : desc(walletAccounts.updatedAt),
      )
      .limit(input.limit)
      .offset((input.page - 1) * input.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(walletAccounts)
      .leftJoin(
        user,
        and(
          eq(walletAccounts.ownerType, "user"),
          eq(user.id, walletAccounts.ownerId),
        ),
      )
      .where(where),
  ]);

  const spent = new Map<string, string>();
  if (rows.length > 0) {
    const spentRows = await db
      .select({
        accountId: walletTransactions.accountId,
        amount: sql<string>`(-sum(${walletTransactions.amount}))::text`,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.type, "usage"),
          gte(walletTransactions.createdAt, startOfWindow(30)),
          inArray(
            walletTransactions.accountId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(walletTransactions.accountId);
    for (const r of spentRows) spent.set(r.accountId, r.amount);
  }

  return {
    total: count?.total ?? 0,
    wallets: rows.map((r) => ({
      id: r.id,
      ownerType: r.ownerType,
      ownerId: r.ownerId,
      name: r.name,
      email: r.email,
      balance: r.balance.toString(),
      isUnlimited: r.isUnlimited,
      canSpend: r.isUnlimited || r.balance > 0n,
      spent30d: spent.get(r.id) ?? "0",
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}
