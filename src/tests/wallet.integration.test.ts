import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { organization, user } from "../db/auth-schema.js";
import {
  applications,
  walletAccounts,
  walletTransactions,
} from "../db/schema.js";
import { ApiError } from "../errors.js";
import {
  MAX_WALLET_AMOUNT,
  MICRO_PER_EUR,
  creditWallet,
  debitWallet,
  findWalletAccount,
  getOrCreateWalletAccount,
} from "../services/wallet/index.js";
import { cleanDb } from "./helpers/db.js";

async function seedUser(id: string): Promise<void> {
  await db.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function newAccount(userId = "u1"): Promise<string> {
  await seedUser(userId);
  return (await getOrCreateWalletAccount("user", userId)).id;
}

async function balanceOf(accountId: string): Promise<bigint> {
  const [row] = await db
    .select({ balance: walletAccounts.balance })
    .from(walletAccounts)
    .where(eq(walletAccounts.id, accountId));
  return row!.balance;
}

async function ledgerOf(accountId: string) {
  return db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.accountId, accountId))
    .orderBy(walletTransactions.createdAt);
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const topup = (accountId: string, amount: bigint, key: string) =>
  creditWallet({ accountId, type: "topup", amount, idempotencyKey: key });
const usage = (accountId: string, amount: bigint, key: string) =>
  debitWallet({ accountId, type: "usage", amount, idempotencyKey: key });

beforeEach(async () => {
  await cleanDb();
});

describe("wallet accounts", () => {
  it("creates an empty wallet on first use and returns the same one afterwards", async () => {
    await seedUser("u1");
    const first = await getOrCreateWalletAccount("user", "u1");
    expect(first.balance).toBe(0n);
    expect(first.isUnlimited).toBe(false);
    const second = await getOrCreateWalletAccount("user", "u1");
    expect(second.id).toBe(first.id);
  });

  it("creates a single wallet under concurrent first use", async () => {
    await seedUser("u1");
    const accounts = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateWalletAccount("user", "u1")),
    );
    expect(new Set(accounts.map((a) => a.id)).size).toBe(1);
  });

  it("keeps user and organization wallets apart", async () => {
    await seedUser("same-id");
    await db.insert(organization).values({
      id: "same-id",
      name: "Org",
      slug: "org",
      createdAt: new Date(),
    });
    const userWallet = await getOrCreateWalletAccount("user", "same-id");
    const orgWallet = await getOrCreateWalletAccount("org", "same-id");
    expect(orgWallet.id).not.toBe(userWallet.id);
  });

  it("rejects an unknown user or organization", async () => {
    expect((await rejection(getOrCreateWalletAccount("user", "nobody"))).code).toBe(
      "USR_001",
    );
    expect((await rejection(getOrCreateWalletAccount("org", "nobody"))).code).toBe(
      "ORG_001",
    );
  });

  it("does not create a wallet when only reading", async () => {
    await seedUser("u1");
    expect(await findWalletAccount("user", "u1")).toBeUndefined();
  });
});

describe("wallet ledger", () => {
  it("credits and debits with a running balance", async () => {
    const id = await newAccount();
    const credited = await topup(id, 5n * MICRO_PER_EUR, "k1");
    expect(credited.transaction.balanceAfter).toBe(5n * MICRO_PER_EUR);
    expect(credited.replayed).toBe(false);

    const debited = await usage(id, 1_500n, "k2");
    expect(debited.transaction.amount).toBe(-1_500n);
    expect(debited.transaction.delta).toBe(-1_500n);
    expect(debited.transaction.balanceAfter).toBe(5n * MICRO_PER_EUR - 1_500n);
    expect(await balanceOf(id)).toBe(5n * MICRO_PER_EUR - 1_500n);
  });

  it("stores application and metadata on the ledger row", async () => {
    const id = await newAccount();
    await topup(id, 100n, "seed");
    const [app] = await db
      .insert(applications)
      .values({ name: "App", slug: "app" })
      .returning({ id: applications.id });
    const { transaction } = await debitWallet({
      accountId: id,
      type: "usage",
      amount: 10n,
      idempotencyKey: "k",
      applicationId: app!.id,
      metadata: { model: "m", tokens: 42 },
    });
    expect(transaction.applicationId).toBe(app!.id);
    expect(transaction.metadata).toEqual({ model: "m", tokens: 42 });

    await db.delete(applications).where(eq(applications.id, app!.id));
    const rows = await ledgerOf(id);
    expect(rows.find((r) => r.idempotencyKey === "k")!.applicationId).toBeNull();
  });

  it("records usage that exceeds the balance as a debt and repays it on the next top-up", async () => {
    const id = await newAccount();
    await topup(id, 100n, "k1");
    await usage(id, 100n, "k2");
    expect(await balanceOf(id)).toBe(0n);

    const over = await usage(id, 40n, "k3");
    expect(over.transaction).toMatchObject({ amount: -40n, delta: -40n, balanceAfter: -40n });
    expect(await balanceOf(id)).toBe(-40n);

    const partial = await topup(id, 30n, "k4");
    expect(partial.transaction.balanceAfter).toBe(-10n);
    const repaid = await topup(id, 100n, "k5");
    expect(repaid.transaction.balanceAfter).toBe(90n);
  });

  it("lets a payment reversal take the balance below zero", async () => {
    const id = await newAccount();
    await topup(id, 100n, "k1");
    await usage(id, 80n, "k2");
    const reversal = await debitWallet({
      accountId: id,
      type: "reversal",
      amount: 100n,
      idempotencyKey: "k3",
    });
    expect(reversal.transaction).toMatchObject({ type: "reversal", amount: -100n, balanceAfter: -80n });
  });

  it("rejects a manual debit that would overdraw, leaving no trace", async () => {
    const id = await newAccount();
    await topup(id, 100n, "k1");
    const err = await rejection(
      debitWallet({ accountId: id, type: "adjust", amount: 101n, idempotencyKey: "k2" }),
    );
    expect(err.code).toBe("WAL_002");
    expect(err.statusCode).toBe(402);
    expect(err.details).toEqual({ balance: "100", required: "101" });
    expect(await balanceOf(id)).toBe(100n);
    expect(await ledgerOf(id)).toHaveLength(1);
  });

  it("refuses a manual debit while the balance is already negative", async () => {
    const id = await newAccount();
    await usage(id, 10n, "k1");
    const err = await rejection(
      debitWallet({ accountId: id, type: "adjust", amount: 1n, idempotencyKey: "k2" }),
    );
    expect(err.code).toBe("WAL_002");
    expect(await balanceOf(id)).toBe(-10n);
  });

  it("applies a replayed key once and returns the original transaction", async () => {
    const id = await newAccount();
    await topup(id, 1_000n, "k1");
    const first = await usage(id, 300n, "dup");
    const second = await usage(id, 300n, "dup");
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await balanceOf(id)).toBe(700n);
    expect(await ledgerOf(id)).toHaveLength(2);
  });

  it("rejects a key reused with different parameters", async () => {
    const id = await newAccount();
    await topup(id, 1_000n, "k1");
    await usage(id, 300n, "dup");
    expect((await rejection(usage(id, 301n, "dup"))).code).toBe("WAL_003");
    expect(
      (
        await rejection(
          debitWallet({ accountId: id, type: "adjust", amount: 300n, idempotencyKey: "dup" }),
        )
      ).code,
    ).toBe("WAL_003");
    expect(await balanceOf(id)).toBe(700n);
  });

  it("scopes idempotency keys per account", async () => {
    const a = await newAccount("u1");
    const b = await newAccount("u2");
    await topup(a, 10n, "shared");
    const other = await topup(b, 10n, "shared");
    expect(other.replayed).toBe(false);
  });

  it("serialises concurrent manual debits: exactly the affordable ones succeed", async () => {
    const id = await newAccount();
    await topup(id, 100n, "seed");
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        debitWallet({ accountId: id, type: "adjust", amount: 10n, idempotencyKey: `c${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(15);
    for (const r of failed) {
      expect((r.reason as ApiError).code).toBe("WAL_002");
    }
    expect(await balanceOf(id)).toBe(0n);
    expect(await ledgerOf(id)).toHaveLength(11);
  });

  it("serialises concurrent usage: every call is recorded and the debt is exact", async () => {
    const id = await newAccount();
    await topup(id, 100n, "seed");
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => usage(id, 10n, `u${i}`)),
    );
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(await balanceOf(id)).toBe(-150n);
    const rows = await ledgerOf(id);
    expect(rows).toHaveLength(26);
    expect(new Set(rows.map((r) => r.balanceAfter)).size).toBe(26);
  });

  it("applies one of many concurrent attempts with the same key", async () => {
    const id = await newAccount();
    await topup(id, 100n, "seed");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => usage(id, 10n, "same")),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(await balanceOf(id)).toBe(90n);
  });

  it("keeps the balance equal to the sum of ledger deltas", async () => {
    const id = await newAccount();
    await topup(id, 1_000n, "a");
    await usage(id, 123n, "b");
    await creditWallet({ accountId: id, type: "grant", amount: 50n, idempotencyKey: "c" });
    await creditWallet({ accountId: id, type: "refund", amount: 23n, idempotencyKey: "d" });
    await debitWallet({ accountId: id, type: "adjust", amount: 10n, idempotencyKey: "e" });
    const [sum] = await db
      .select({ total: sql<string>`sum(${walletTransactions.delta})` })
      .from(walletTransactions)
      .where(eq(walletTransactions.accountId, id));
    expect(BigInt(sum!.total)).toBe(await balanceOf(id));
    expect(await balanceOf(id)).toBe(940n);
  });

  it("rejects an unknown account", async () => {
    const err = await rejection(
      topup("00000000-0000-0000-0000-000000000000", 1n, "k"),
    );
    expect(err.code).toBe("WAL_001");
  });

  it.each([
    ["zero", 0n],
    ["negative", -5n],
    ["above the maximum", MAX_WALLET_AMOUNT + 1n],
  ])("rejects a %s amount", async (_label, amount) => {
    const id = await newAccount();
    expect((await rejection(topup(id, amount, "k"))).code).toBe("WAL_004");
    expect((await rejection(usage(id, amount, "k"))).code).toBe("WAL_004");
  });

  it("rejects a non-bigint amount", async () => {
    const id = await newAccount();
    const err = await rejection(topup(id, 5 as unknown as bigint, "k"));
    expect(err.code).toBe("WAL_004");
  });

  it("rejects an empty or oversized idempotency key", async () => {
    const id = await newAccount();
    expect((await rejection(topup(id, 1n, ""))).code).toBe("WAL_004");
    expect((await rejection(topup(id, 1n, "x".repeat(256)))).code).toBe(
      "WAL_004",
    );
  });
});

describe("unlimited accounts", () => {
  it("records usage without touching the balance", async () => {
    const id = await newAccount();
    await db
      .update(walletAccounts)
      .set({ isUnlimited: true })
      .where(eq(walletAccounts.id, id));

    const { transaction } = await usage(id, 5_000n, "u1");
    expect(transaction.amount).toBe(-5_000n);
    expect(transaction.delta).toBe(0n);
    expect(transaction.balanceAfter).toBe(0n);
    expect(await balanceOf(id)).toBe(0n);

    await topup(id, 200n, "t1");
    expect(await balanceOf(id)).toBe(200n);
  });

  it("still deducts non-usage debits", async () => {
    const id = await newAccount();
    await topup(id, 100n, "t");
    await db
      .update(walletAccounts)
      .set({ isUnlimited: true })
      .where(eq(walletAccounts.id, id));
    await debitWallet({ accountId: id, type: "adjust", amount: 40n, idempotencyKey: "a" });
    expect(await balanceOf(id)).toBe(60n);
  });
});

describe("database constraints", () => {
  it("refuses a manual debit row that leaves a negative balance", async () => {
    const id = await newAccount();
    await expect(
      db.insert(walletTransactions).values({
        accountId: id,
        type: "adjust",
        amount: -5n,
        delta: -5n,
        balanceAfter: -5n,
        idempotencyKey: "bad",
      }),
    ).rejects.toThrow();
  });

  it("accepts usage and reversal rows that leave a negative balance", async () => {
    const id = await newAccount();
    for (const type of ["usage", "reversal"] as const) {
      await db.insert(walletTransactions).values({
        accountId: id,
        type,
        amount: -5n,
        delta: -5n,
        balanceAfter: -5n,
        idempotencyKey: `ok-${type}`,
      });
    }
    expect(await ledgerOf(id)).toHaveLength(2);
  });

  it("refuses a reversal row with a positive amount", async () => {
    const id = await newAccount();
    await expect(
      db.insert(walletTransactions).values({
        accountId: id,
        type: "reversal",
        amount: 5n,
        delta: 5n,
        balanceAfter: 5n,
        idempotencyKey: "bad",
      }),
    ).rejects.toThrow();
  });

  it("refuses a usage row with a positive amount", async () => {
    const id = await newAccount();
    await expect(
      db.insert(walletTransactions).values({
        accountId: id,
        type: "usage",
        amount: 5n,
        delta: 5n,
        balanceAfter: 5n,
        idempotencyKey: "bad",
      }),
    ).rejects.toThrow();
  });

  it("refuses a top-up row whose delta differs from its amount", async () => {
    const id = await newAccount();
    await expect(
      db.insert(walletTransactions).values({
        accountId: id,
        type: "topup",
        amount: 5n,
        delta: 0n,
        balanceAfter: 0n,
        idempotencyKey: "bad",
      }),
    ).rejects.toThrow();
  });

  it("refuses an unknown owner type", async () => {
    await expect(
      db.insert(walletAccounts).values({ ownerType: "team", ownerId: "x" }),
    ).rejects.toThrow();
  });
});
