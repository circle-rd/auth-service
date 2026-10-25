import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  walletAccounts,
  walletTransactions,
} from "../db/schema.js";
import {
  creditWallet,
  getAdminWalletStats,
  getOrCreateWalletAccount,
  getUserSpendStats,
  listGatewayUsage,
  listWalletAccounts,
} from "../services/wallet/index.js";
import { cleanDb } from "./helpers/db.js";

const DAY_MS = 86_400_000;

function daysAgo(n: number, hour = 12): Date {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return new Date(d.getTime() - n * DAY_MS);
}

async function seedUser(id: string, name = id, email = `${id}@example.com`) {
  await db.insert(user).values({
    id,
    name,
    email,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function newAccount(userId: string, name?: string): Promise<string> {
  await seedUser(userId, name);
  return (await getOrCreateWalletAccount("user", userId)).id;
}

/** Insert a historical ledger row: the service always stamps "now". */
async function row(
  accountId: string,
  opts: {
    type?: "usage" | "topup" | "grant";
    amount: bigint;
    at: Date;
    applicationId?: string | null;
    metadata?: Record<string, unknown>;
    unlimited?: boolean;
  },
) {
  const type = opts.type ?? "usage";
  await db.insert(walletTransactions).values({
    accountId,
    type,
    amount: opts.amount,
    delta: opts.unlimited ? 0n : opts.amount,
    balanceAfter: 0n,
    idempotencyKey: `k-${Math.random()}`,
    applicationId: opts.applicationId ?? null,
    metadata: opts.metadata ?? {},
    createdAt: opts.at,
  });
}

async function setBalance(accountId: string, balance: bigint, unlimited = false) {
  await db
    .update(walletAccounts)
    .set({ balance, isUnlimited: unlimited })
    .where(eq(walletAccounts.id, accountId));
}

beforeEach(async () => {
  await cleanDb();
});

describe("getUserSpendStats", () => {
  it("returns a dense zero-filled daily series of real spend", async () => {
    const id = await newAccount("u1");
    await row(id, { amount: -1_000n, at: daysAgo(0) });
    await row(id, { amount: -500n, at: daysAgo(0, 3) });
    await row(id, { amount: -200n, at: daysAgo(2) });

    const stats = await getUserSpendStats(id, 7);
    expect(stats.series).toHaveLength(7);
    expect(stats.series.map((p) => p.date)).toEqual([...stats.series.map((p) => p.date)].sort());
    const byDate = new Map(stats.series.map((p) => [p.date, p]));
    expect(byDate.get(daysAgo(0).toISOString().slice(0, 10))).toMatchObject({ amount: "1500", count: 2 });
    expect(byDate.get(daysAgo(2).toISOString().slice(0, 10))).toMatchObject({ amount: "200", count: 1 });
    expect(byDate.get(daysAgo(1).toISOString().slice(0, 10))).toMatchObject({ amount: "0", count: 0 });
    expect(stats.total).toBe("1700");
    expect(stats.calls).toBe(3);
  });

  it("ignores top-ups and usage outside the window", async () => {
    const id = await newAccount("u1");
    await row(id, { type: "topup", amount: 9_000n, at: daysAgo(0) });
    await row(id, { amount: -100n, at: daysAgo(0) });
    await row(id, { amount: -777n, at: daysAgo(30) });
    const stats = await getUserSpendStats(id, 7);
    expect(stats.total).toBe("100");
    expect(stats.calls).toBe(1);
  });

  it("counts the real spend of an unlimited account", async () => {
    const id = await newAccount("u1");
    await row(id, { amount: -4_000n, at: daysAgo(0), unlimited: true });
    expect((await getUserSpendStats(id, 7)).total).toBe("4000");
  });

  it("reports the unbilled share of the spend (unlimited accounts)", async () => {
    const id = await newAccount("u1");
    await row(id, { amount: -4_000n, at: daysAgo(0), unlimited: true });
    await row(id, { amount: -1_000n, at: daysAgo(1) });
    await row(id, { amount: -900n, at: daysAgo(30), unlimited: true });
    const stats = await getUserSpendStats(id, 7);
    expect(stats.total).toBe("5000");
    expect(stats.notBilled).toBe("4000");
  });

  it("breaks the spend down by application and by kind", async () => {
    const id = await newAccount("u1");
    const [chat] = await db.insert(applications).values({ name: "Chat", slug: "chat" }).returning({ id: applications.id });
    const [docs] = await db.insert(applications).values({ name: "Docs", slug: "docs" }).returning({ id: applications.id });
    await row(id, { amount: -300n, at: daysAgo(0), applicationId: chat!.id, metadata: { kind: "llm" } });
    await row(id, { amount: -200n, at: daysAgo(1), applicationId: chat!.id, metadata: { kind: "mcp" } });
    await row(id, { amount: -900n, at: daysAgo(1), applicationId: docs!.id, metadata: { kind: "llm" } });
    await row(id, { amount: -50n, at: daysAgo(0), metadata: { applicationSlug: "gone-app" } });

    const stats = await getUserSpendStats(id, 7);
    expect(stats.byApplication.map((a) => [a.slug, a.amount, a.count])).toEqual([
      ["docs", "900", 1],
      ["chat", "500", 2],
      ["gone-app", "50", 1],
    ]);
    expect(stats.byApplication[0]).toMatchObject({ name: "Docs", applicationId: docs!.id });
    expect(stats.byApplication[2]).toMatchObject({ applicationId: null, name: "gone-app" });
    expect(stats.byKind.map((k) => [k.kind, k.amount])).toEqual([
      ["llm", "1200"],
      ["mcp", "200"],
      ["other", "50"],
    ]);
  });

  it("only sees its own account", async () => {
    const a = await newAccount("u1");
    const b = await newAccount("u2");
    await row(a, { amount: -100n, at: daysAgo(0) });
    await row(b, { amount: -900n, at: daysAgo(0) });
    expect((await getUserSpendStats(a, 7)).total).toBe("100");
  });

  it("is empty for an account that never spent", async () => {
    const id = await newAccount("u1");
    const stats = await getUserSpendStats(id, 30);
    expect(stats).toMatchObject({ total: "0", calls: 0, byApplication: [], byKind: [] });
    expect(stats.series).toHaveLength(30);
  });
});

describe("getAdminWalletStats", () => {
  it("totals what is owed to users and by users, excluding unlimited accounts from credit", async () => {
    const a = await newAccount("u1");
    const b = await newAccount("u2");
    const c = await newAccount("u3");
    const d = await newAccount("u4");
    await setBalance(a, 5_000n);
    await setBalance(b, 2_500n);
    await setBalance(c, -700n);
    await setBalance(d, 99_000n, true);

    const { totals } = await getAdminWalletStats(7);
    expect(totals).toEqual({
      accounts: 4,
      accountsInDebt: 1,
      unlimitedAccounts: 1,
      outstandingCredit: "7500",
      outstandingDebt: "700",
    });
  });

  it("reports spend and top-up series with their totals", async () => {
    const a = await newAccount("u1");
    const b = await newAccount("u2");
    await row(a, { amount: -400n, at: daysAgo(0) });
    await row(a, { amount: -100n, at: daysAgo(1) });
    await row(b, { amount: -250n, at: daysAgo(1), unlimited: true });
    await row(a, { type: "topup", amount: 10_000n, at: daysAgo(1) });
    await row(a, { type: "grant", amount: 5_000n, at: daysAgo(1) });

    const stats = await getAdminWalletStats(7);
    expect(stats.spend).toMatchObject({
      total: "750",
      notBilled: "250",
      calls: 3,
    });
    expect(stats.spend.series).toHaveLength(7);
    expect(stats.topUps).toMatchObject({ total: "10000", count: 1 });
  });

  it("ranks the top consumers with their identity, at most five", async () => {
    for (let i = 1; i <= 6; i += 1) {
      const id = await newAccount(`u${i}`, `User ${i}`);
      await row(id, { amount: BigInt(-i * 100), at: daysAgo(0) });
    }
    const { topConsumers } = await getAdminWalletStats(7);
    expect(topConsumers).toHaveLength(5);
    expect(topConsumers[0]).toMatchObject({ name: "User 6", email: "u6@example.com", amount: "600", count: 1 });
    expect(topConsumers.map((t) => t.amount)).toEqual(["600", "500", "400", "300", "200"]);
  });

  it("is all zeros on an empty platform", async () => {
    const stats = await getAdminWalletStats(7);
    expect(stats.totals).toEqual({
      accounts: 0,
      accountsInDebt: 0,
      unlimitedAccounts: 0,
      outstandingCredit: "0",
      outstandingDebt: "0",
    });
    expect(stats.spend.total).toBe("0");
    expect(stats.topConsumers).toEqual([]);
  });
});

describe("listWalletAccounts", () => {
  async function seedFour() {
    const a = await newAccount("alice", "Alice Martin");
    const b = await newAccount("bob", "Bob Durand");
    const c = await newAccount("carol", "Carol 100%");
    const d = await newAccount("dave", "Dave Staff");
    await setBalance(a, 5_000n);
    await setBalance(b, -300n);
    await setBalance(c, 0n);
    await setBalance(d, 0n, true);
    await row(a, { amount: -250n, at: daysAgo(1) });
    await row(a, { amount: -999n, at: daysAgo(40) });
  }

  it("filters by state", async () => {
    await seedFour();
    const names = async (filter: "all" | "debt" | "credit" | "unlimited") =>
      (await listWalletAccounts({ page: 1, limit: 20, filter })).wallets.map((w) => w.name).sort();
    expect(await names("all")).toEqual(["Alice Martin", "Bob Durand", "Carol 100%", "Dave Staff"]);
    expect(await names("debt")).toEqual(["Bob Durand"]);
    expect(await names("credit")).toEqual(["Alice Martin"]);
    expect(await names("unlimited")).toEqual(["Dave Staff"]);
  });

  it("describes each wallet with its state and 30-day spend", async () => {
    await seedFour();
    const { wallets } = await listWalletAccounts({ page: 1, limit: 20, filter: "all" });
    const byName = new Map(wallets.map((w) => [w.name, w]));
    expect(byName.get("Alice Martin")).toMatchObject({ balance: "5000", canSpend: true, spent30d: "250", email: "alice@example.com" });
    expect(byName.get("Bob Durand")).toMatchObject({ balance: "-300", canSpend: false, spent30d: "0" });
    expect(byName.get("Carol 100%")).toMatchObject({ canSpend: false });
    expect(byName.get("Dave Staff")).toMatchObject({ canSpend: true, isUnlimited: true });
  });

  it("searches name, email and id, treating wildcards literally", async () => {
    await seedFour();
    const search = async (q: string) =>
      (await listWalletAccounts({ page: 1, limit: 20, filter: "all", search: q })).wallets.map((w) => w.name);
    expect(await search("martin")).toEqual(["Alice Martin"]);
    expect(await search("BOB@EXAMPLE")).toEqual(["Bob Durand"]);
    expect(await search("carol")).toEqual(["Carol 100%"]);
    expect(await search("100%")).toEqual(["Carol 100%"]);
    expect(await search("%")).toEqual(["Carol 100%"]);
    expect(await search("_")).toEqual([]);
    expect(await search("nobody")).toEqual([]);
  });

  it("paginates with a stable total", async () => {
    await seedFour();
    const first = await listWalletAccounts({ page: 1, limit: 3, filter: "all" });
    const second = await listWalletAccounts({ page: 2, limit: 3, filter: "all" });
    expect(first.total).toBe(4);
    expect(first.wallets).toHaveLength(3);
    expect(second.wallets).toHaveLength(1);
    expect(new Set([...first.wallets, ...second.wallets].map((w) => w.id)).size).toBe(4);
  });

  it("lists the most indebted first when filtering debt", async () => {
    const a = await newAccount("a");
    const b = await newAccount("b");
    await setBalance(a, -100n);
    await setBalance(b, -900n);
    const { wallets } = await listWalletAccounts({ page: 1, limit: 20, filter: "debt" });
    expect(wallets.map((w) => w.balance)).toEqual(["-900", "-100"]);
  });

  it("lists an organization wallet without a user identity", async () => {
    await db.insert(walletAccounts).values({ ownerType: "org", ownerId: "org-1" });
    const { wallets } = await listWalletAccounts({ page: 1, limit: 20, filter: "all" });
    expect(wallets[0]).toMatchObject({ ownerType: "org", ownerId: "org-1", name: null, email: null });
  });
});

describe("a ledger written through the service", () => {
  it("feeds the statistics", async () => {
    const id = await newAccount("u1");
    await creditWallet({ accountId: id, type: "topup", amount: 10_000n, idempotencyKey: "t" });
    const admin = await getAdminWalletStats(7);
    expect(admin.topUps.total).toBe("10000");
    expect(admin.totals.outstandingCredit).toBe("10000");
  });
});

describe("listGatewayUsage", () => {
  const WINDOW = {
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-10-02T00:00:00Z"),
  };

  async function usageRow(
    accountId: string,
    key: string,
    at: Date,
    over: { type?: "usage" | "topup"; metadata?: Record<string, unknown> } = {},
  ) {
    const type = over.type ?? "usage";
    const amount = type === "usage" ? -100n : 100n;
    await db.insert(walletTransactions).values({
      accountId,
      type,
      amount,
      delta: amount,
      balanceAfter: 0n,
      idempotencyKey: key,
      metadata: over.metadata ?? { requestId: `call-${key}`, costUsd: "0.1" },
      createdAt: at,
    });
  }

  beforeEach(cleanDb);

  it("lists only gateway usage inside the window, oldest first", async () => {
    const acc = await newAccount("u-recon");
    const at = (h: number) => new Date(`2026-10-01T${h}:00:00Z`);
    await usageRow(acc, "litellm:b", at(11));
    await usageRow(acc, "litellm:a", at(10));
    await usageRow(acc, "litellm:late", new Date("2026-10-02T00:00:00Z"));
    await usageRow(acc, "litellm:early", new Date("2026-09-30T23:59:59Z"));
    await usageRow(acc, "manual-key", at(12));
    await usageRow(acc, "litellm:topup", at(12), { type: "topup" });

    const page = await listGatewayUsage({ ...WINDOW, limit: 100 });
    expect(page.items.map((i) => i.requestId)).toEqual(["call-litellm:a", "call-litellm:b"]);
    expect(page.items[0]).toMatchObject({
      userId: "u-recon",
      amount: "-100",
      costUsd: "0.1",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("exposes a missing call id as null", async () => {
    const acc = await newAccount("u-nocall");
    await usageRow(acc, "litellm:x", new Date("2026-10-01T10:00:00Z"), {
      metadata: {},
    });
    const [entry] = (await listGatewayUsage({ ...WINDOW, limit: 10 })).items;
    expect(entry).toMatchObject({ requestId: null, costUsd: null });
  });

  it("paginates without skipping or repeating rows", async () => {
    const acc = await newAccount("u-pages");
    for (let i = 0; i < 5; i += 1) {
      // Same timestamp: the cursor must break ties on the id.
      await usageRow(acc, `litellm:p${i}`, new Date("2026-10-01T10:00:00Z"));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listGatewayUsage({ ...WINDOW, limit: 2, cursor });
      seen.push(...page.items.map((i) => i.requestId ?? ""));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});
