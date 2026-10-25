import { and, count, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  subscriptionPlans,
  userSubscriptionEvents,
  walletAccountEvents,
  walletAccounts,
  walletTransactions,
} from "../db/schema.js";

// Read-only, merged view of every administrative or billing action stored
// across three audit tables. Metered `usage` rows are left out on purpose: they
// are consumption, already covered by the usage ledger.

export const WALLET_JOURNAL_KINDS = [
  "topup",
  "grant",
  "refund",
  "adjust",
  "reversal",
] as const;
export const ACCOUNT_JOURNAL_KINDS = [
  "unlimited_enabled",
  "unlimited_disabled",
] as const;
export const SUBSCRIPTION_JOURNAL_KINDS = [
  "subscription_assigned",
  "subscription_changed",
  "subscription_removed",
] as const;
export const JOURNAL_KINDS = [
  ...WALLET_JOURNAL_KINDS,
  ...ACCOUNT_JOURNAL_KINDS,
  ...SUBSCRIPTION_JOURNAL_KINDS,
] as const;

export type JournalKind = (typeof JOURNAL_KINDS)[number];
type WalletKind = (typeof WALLET_JOURNAL_KINDS)[number];
type AccountKind = (typeof ACCOUNT_JOURNAL_KINDS)[number];
type SubscriptionKind = (typeof SUBSCRIPTION_JOURNAL_KINDS)[number];

/** Largest `page * limit` served: every source is read up to that depth. */
export const MAX_JOURNAL_WINDOW = 5000;

export interface JournalQuery {
  page: number;
  limit: number;
  kind?: JournalKind;
  userId?: string;
  applicationId?: string;
  from?: Date;
  to?: Date;
}

export interface JournalPerson {
  id: string;
  name: string | null;
  email: string | null;
}

export interface JournalOwner extends JournalPerson {
  type: "user" | "org";
}

export interface JournalEntryView {
  id: string;
  kind: JournalKind;
  createdAt: string;
  /** Wallet owner or subscriber. */
  owner: JournalOwner;
  /** Administrator who acted; null for automatic paths (Stripe, default plan). */
  actor: JournalPerson | null;
  /** `manual` / `stripe` for money, `admin` / `self` / `default` / `stripe` otherwise. */
  source: string | null;
  application: { id: string; name: string; slug: string } | null;
  /** Signed micro-euros. */
  amount: string | null;
  balanceAfter: string | null;
  fromPlan: string | null;
  toPlan: string | null;
  reason: string | null;
  reference: string | null;
}

export interface JournalPage {
  entries: JournalEntryView[];
  total: number;
  page: number;
  limit: number;
}

interface SourceEntry {
  createdAt: Date;
  id: string;
  actorId: string | null;
  view: Omit<JournalEntryView, "actor">;
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function narrow<T extends JournalKind>(
  all: readonly T[],
  kind: JournalKind | undefined,
): T[] {
  return kind ? all.filter((k) => k === kind) : [...all];
}

function ownerOf(row: {
  ownerType: string;
  ownerId: string;
  name: string | null;
  email: string | null;
}): JournalOwner {
  return {
    type: row.ownerType === "org" ? "org" : "user",
    id: row.ownerId,
    name: row.name,
    email: row.email,
  };
}

function ownedByUser(userId: string | undefined): SQL | undefined {
  return userId
    ? and(
        eq(walletAccounts.ownerType, "user"),
        eq(walletAccounts.ownerId, userId),
      )
    : undefined;
}

// ── Wallet transactions ───────────────────────────────────────────────────────

function walletTransactionsWhere(
  input: JournalQuery,
  kinds: WalletKind[],
): SQL | undefined {
  return and(
    inArray(walletTransactions.type, kinds),
    ownedByUser(input.userId),
    input.applicationId
      ? eq(walletTransactions.applicationId, input.applicationId)
      : undefined,
    input.from ? gte(walletTransactions.createdAt, input.from) : undefined,
    input.to ? lt(walletTransactions.createdAt, input.to) : undefined,
  );
}

async function readWalletTransactions(
  input: JournalQuery,
  kinds: WalletKind[],
  window: number,
): Promise<SourceEntry[]> {
  const rows = await db
    .select({
      id: walletTransactions.id,
      type: walletTransactions.type,
      amount: walletTransactions.amount,
      balanceAfter: walletTransactions.balanceAfter,
      metadata: walletTransactions.metadata,
      createdAt: walletTransactions.createdAt,
      ownerType: walletAccounts.ownerType,
      ownerId: walletAccounts.ownerId,
      name: user.name,
      email: user.email,
      appId: applications.id,
      appName: applications.name,
      appSlug: applications.slug,
    })
    .from(walletTransactions)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletTransactions.accountId),
    )
    .leftJoin(
      user,
      and(
        eq(walletAccounts.ownerType, "user"),
        eq(user.id, walletAccounts.ownerId),
      ),
    )
    .leftJoin(
      applications,
      eq(applications.id, walletTransactions.applicationId),
    )
    .where(walletTransactionsWhere(input, kinds))
    .orderBy(desc(walletTransactions.createdAt), desc(walletTransactions.id))
    .limit(window);

  return rows.map((row) => ({
    createdAt: row.createdAt,
    id: row.id,
    actorId: readString(row.metadata, "actorId"),
    view: {
      id: `tx:${row.id}`,
      kind: row.type as WalletKind,
      createdAt: row.createdAt.toISOString(),
      owner: ownerOf(row),
      source: readString(row.metadata, "source"),
      application: row.appId
        ? { id: row.appId, name: row.appName ?? "", slug: row.appSlug ?? "" }
        : null,
      amount: row.amount.toString(),
      balanceAfter: row.balanceAfter.toString(),
      fromPlan: null,
      toPlan: null,
      reason: readString(row.metadata, "reason"),
      reference: readString(row.metadata, "reference"),
    },
  }));
}

async function countWalletTransactions(
  input: JournalQuery,
  kinds: WalletKind[],
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(walletTransactions)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletTransactions.accountId),
    )
    .where(walletTransactionsWhere(input, kinds));
  return Number(row?.total ?? 0);
}

// ── Wallet account events ─────────────────────────────────────────────────────

function accountEventsWhere(
  input: JournalQuery,
  kinds: AccountKind[],
): SQL | undefined {
  return and(
    inArray(walletAccountEvents.action, kinds),
    ownedByUser(input.userId),
    input.from ? gte(walletAccountEvents.createdAt, input.from) : undefined,
    input.to ? lt(walletAccountEvents.createdAt, input.to) : undefined,
  );
}

async function readAccountEvents(
  input: JournalQuery,
  kinds: AccountKind[],
  window: number,
): Promise<SourceEntry[]> {
  const rows = await db
    .select({
      id: walletAccountEvents.id,
      action: walletAccountEvents.action,
      actorUserId: walletAccountEvents.actorUserId,
      details: walletAccountEvents.details,
      createdAt: walletAccountEvents.createdAt,
      ownerType: walletAccounts.ownerType,
      ownerId: walletAccounts.ownerId,
      name: user.name,
      email: user.email,
    })
    .from(walletAccountEvents)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletAccountEvents.accountId),
    )
    .leftJoin(
      user,
      and(
        eq(walletAccounts.ownerType, "user"),
        eq(user.id, walletAccounts.ownerId),
      ),
    )
    .where(accountEventsWhere(input, kinds))
    .orderBy(desc(walletAccountEvents.createdAt), desc(walletAccountEvents.id))
    .limit(window);

  return rows.map((row) => ({
    createdAt: row.createdAt,
    id: row.id,
    actorId: row.actorUserId,
    view: {
      id: `evt:${row.id}`,
      kind: row.action as AccountKind,
      createdAt: row.createdAt.toISOString(),
      owner: ownerOf(row),
      source: "admin",
      application: null,
      amount: null,
      balanceAfter: null,
      fromPlan: null,
      toPlan: null,
      reason: readString(row.details, "reason"),
      reference: null,
    },
  }));
}

async function countAccountEvents(
  input: JournalQuery,
  kinds: AccountKind[],
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(walletAccountEvents)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletAccountEvents.accountId),
    )
    .where(accountEventsWhere(input, kinds));
  return Number(row?.total ?? 0);
}

// ── Subscription events ───────────────────────────────────────────────────────

const toAction = (kind: SubscriptionKind): string =>
  kind.slice("subscription_".length);

function subscriptionEventsWhere(
  input: JournalQuery,
  kinds: SubscriptionKind[],
): SQL | undefined {
  return and(
    inArray(userSubscriptionEvents.action, kinds.map(toAction)),
    input.userId ? eq(userSubscriptionEvents.userId, input.userId) : undefined,
    input.applicationId
      ? eq(userSubscriptionEvents.applicationId, input.applicationId)
      : undefined,
    input.from ? gte(userSubscriptionEvents.createdAt, input.from) : undefined,
    input.to ? lt(userSubscriptionEvents.createdAt, input.to) : undefined,
  );
}

async function readSubscriptionEvents(
  input: JournalQuery,
  kinds: SubscriptionKind[],
  window: number,
): Promise<SourceEntry[]> {
  const fromPlan = alias(subscriptionPlans, "from_plan");
  const toPlan = alias(subscriptionPlans, "to_plan");
  const rows = await db
    .select({
      id: userSubscriptionEvents.id,
      userId: userSubscriptionEvents.userId,
      action: userSubscriptionEvents.action,
      source: userSubscriptionEvents.source,
      actorUserId: userSubscriptionEvents.actorUserId,
      reason: userSubscriptionEvents.reason,
      createdAt: userSubscriptionEvents.createdAt,
      name: user.name,
      email: user.email,
      appId: applications.id,
      appName: applications.name,
      appSlug: applications.slug,
      fromPlanName: fromPlan.name,
      toPlanName: toPlan.name,
    })
    .from(userSubscriptionEvents)
    .leftJoin(user, eq(user.id, userSubscriptionEvents.userId))
    .innerJoin(
      applications,
      eq(applications.id, userSubscriptionEvents.applicationId),
    )
    .leftJoin(fromPlan, eq(fromPlan.id, userSubscriptionEvents.fromPlanId))
    .leftJoin(toPlan, eq(toPlan.id, userSubscriptionEvents.toPlanId))
    .where(subscriptionEventsWhere(input, kinds))
    .orderBy(
      desc(userSubscriptionEvents.createdAt),
      desc(userSubscriptionEvents.id),
    )
    .limit(window);

  return rows.map((row) => ({
    createdAt: row.createdAt,
    id: row.id,
    actorId: row.actorUserId,
    view: {
      id: `sub:${row.id}`,
      kind: `subscription_${row.action}` as SubscriptionKind,
      createdAt: row.createdAt.toISOString(),
      owner: {
        type: "user",
        id: row.userId,
        name: row.name,
        email: row.email,
      },
      source: row.source,
      application: { id: row.appId, name: row.appName, slug: row.appSlug },
      amount: null,
      balanceAfter: null,
      fromPlan: row.fromPlanName,
      toPlan: row.toPlanName,
      reason: row.reason,
      reference: null,
    },
  }));
}

async function countSubscriptionEvents(
  input: JournalQuery,
  kinds: SubscriptionKind[],
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(userSubscriptionEvents)
    .where(subscriptionEventsWhere(input, kinds));
  return Number(row?.total ?? 0);
}

// ── Merge ─────────────────────────────────────────────────────────────────────

async function resolveActors(
  ids: string[],
): Promise<Map<string, JournalPerson>> {
  const actors = new Map<string, JournalPerson>();
  if (ids.length === 0) return actors;
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, ids));
  for (const row of rows) actors.set(row.id, row);
  return actors;
}

function newestFirst(a: SourceEntry, b: SourceEntry): number {
  const byDate = b.createdAt.getTime() - a.createdAt.getTime();
  if (byDate !== 0) return byDate;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Newest first. Each source is read up to the end of the requested page and the
 * merged result is sliced, so the cost grows with `page * limit` (bounded by
 * `MAX_JOURNAL_WINDOW`) rather than with the size of the history.
 */
export async function listJournal(input: JournalQuery): Promise<JournalPage> {
  const offset = (input.page - 1) * input.limit;
  const window = offset + input.limit;

  const walletKinds = narrow(WALLET_JOURNAL_KINDS, input.kind);
  // Account events carry no application: filtering on one excludes them.
  const accountKinds = input.applicationId
    ? []
    : narrow(ACCOUNT_JOURNAL_KINDS, input.kind);
  const subscriptionKinds = narrow(SUBSCRIPTION_JOURNAL_KINDS, input.kind);

  const [transactions, accountEvents, subscriptionEvents, counts] =
    await Promise.all([
      walletKinds.length
        ? readWalletTransactions(input, walletKinds, window)
        : [],
      accountKinds.length ? readAccountEvents(input, accountKinds, window) : [],
      subscriptionKinds.length
        ? readSubscriptionEvents(input, subscriptionKinds, window)
        : [],
      Promise.all([
        walletKinds.length ? countWalletTransactions(input, walletKinds) : 0,
        accountKinds.length ? countAccountEvents(input, accountKinds) : 0,
        subscriptionKinds.length
          ? countSubscriptionEvents(input, subscriptionKinds)
          : 0,
      ]),
    ]);

  const pageEntries = [...transactions, ...accountEvents, ...subscriptionEvents]
    .sort(newestFirst)
    .slice(offset, window);

  const actors = await resolveActors([
    ...new Set(pageEntries.flatMap((e) => (e.actorId ? [e.actorId] : []))),
  ]);

  return {
    entries: pageEntries.map(({ view, actorId }) => ({
      ...view,
      actor: actorId
        ? (actors.get(actorId) ?? { id: actorId, name: null, email: null })
        : null,
    })),
    total: counts.reduce((sum, n) => sum + n, 0),
    page: input.page,
    limit: input.limit,
  };
}
