import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";
import { MAX_WALLET_AMOUNT, type WalletTransaction } from "./types.js";

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
    transactions: 0,
  };
  const tx = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        for: () => chain,
        limit: () => Promise.resolve(state.selects.shift() ?? []),
      };
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.updates.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push(values);
        return {
          returning: () => Promise.resolve([{ id: "tx-new", ...values }]),
        };
      },
    }),
  };
  const mockDb = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      state.transactions += 1;
      return fn(tx);
    },
  };
  return { mockDb, state };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { creditWallet, debitWallet } = await import("./ledger.js");

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

function account(balance: bigint, isUnlimited = false) {
  return { id: ACCOUNT_ID, balance, isUnlimited };
}

function stored(overrides: Partial<WalletTransaction>): WalletTransaction {
  return {
    id: "tx-old",
    accountId: ACCOUNT_ID,
    type: "usage",
    amount: -100n,
    delta: -100n,
    balanceAfter: 900n,
    idempotencyKey: "k",
    applicationId: null,
    metadata: {},
    createdAt: new Date(),
    ...overrides,
  };
}

/** Script the two reads of a transaction: the account row, then the replay lookup. */
function script(accountRow: unknown, existing?: WalletTransaction) {
  state.selects.push(accountRow ? [accountRow] : []);
  if (accountRow) state.selects.push(existing ? [existing] : []);
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeEach(() => {
  state.selects = [];
  state.updates = [];
  state.inserts = [];
  state.transactions = 0;
});

describe("creditWallet", () => {
  it("adds the amount to the balance and records the ledger row", async () => {
    script(account(1_000n));
    const result = await creditWallet({
      accountId: ACCOUNT_ID,
      type: "topup",
      amount: 500n,
      idempotencyKey: "k",
      applicationId: "app-1",
      metadata: { pack: "10" },
    });
    expect(result.replayed).toBe(false);
    expect(state.updates[0]).toMatchObject({ balance: 1_500n });
    expect(state.inserts[0]).toMatchObject({
      type: "topup",
      amount: 500n,
      delta: 500n,
      balanceAfter: 1_500n,
      applicationId: "app-1",
      metadata: { pack: "10" },
    });
  });
});

describe("debitWallet", () => {
  it("deducts the amount and stores it as a negative value", async () => {
    script(account(1_000n));
    await debitWallet({
      accountId: ACCOUNT_ID,
      type: "usage",
      amount: 300n,
      idempotencyKey: "k",
    });
    expect(state.updates[0]).toMatchObject({ balance: 700n });
    expect(state.inserts[0]).toMatchObject({
      amount: -300n,
      delta: -300n,
      balanceAfter: 700n,
      applicationId: null,
      metadata: {},
    });
  });

  it("allows spending exactly the balance", async () => {
    script(account(300n));
    await debitWallet({
      accountId: ACCOUNT_ID,
      type: "usage",
      amount: 300n,
      idempotencyKey: "k",
    });
    expect(state.updates[0]).toMatchObject({ balance: 0n });
  });

  it("rejects an overdraft and writes nothing", async () => {
    script(account(299n));
    const err = await rejection(
      debitWallet({
        accountId: ACCOUNT_ID,
        type: "usage",
        amount: 300n,
        idempotencyKey: "k",
      }),
    );
    expect(err.code).toBe("WAL_002");
    expect(err.statusCode).toBe(402);
    expect(err.details).toEqual({ balance: "299", required: "300" });
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("records usage on an unlimited account without changing its balance", async () => {
    script(account(0n, true));
    await debitWallet({
      accountId: ACCOUNT_ID,
      type: "usage",
      amount: 5_000n,
      idempotencyKey: "k",
    });
    expect(state.updates[0]).toMatchObject({ balance: 0n });
    expect(state.inserts[0]).toMatchObject({
      amount: -5_000n,
      delta: 0n,
      balanceAfter: 0n,
    });
  });

  it("still deducts a non-usage debit on an unlimited account", async () => {
    script(account(100n, true));
    await debitWallet({
      accountId: ACCOUNT_ID,
      type: "adjust",
      amount: 40n,
      idempotencyKey: "k",
    });
    expect(state.inserts[0]).toMatchObject({ delta: -40n, balanceAfter: 60n });
  });

  it("rejects an unknown account", async () => {
    script(undefined);
    const err = await rejection(
      debitWallet({
        accountId: ACCOUNT_ID,
        type: "usage",
        amount: 1n,
        idempotencyKey: "k",
      }),
    );
    expect(err.code).toBe("WAL_001");
  });
});

describe("idempotency", () => {
  it("returns the original transaction for a replayed key without writing", async () => {
    const original = stored({});
    script(account(900n), original);
    const result = await debitWallet({
      accountId: ACCOUNT_ID,
      type: "usage",
      amount: 100n,
      idempotencyKey: "k",
    });
    expect(result).toEqual({ transaction: original, replayed: true });
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it.each([
    ["amount", { amount: -101n }],
    ["type", { type: "adjust" as const }],
    ["application", { applicationId: "app-2" }],
  ])("rejects a replayed key whose %s differs", async (_label, change) => {
    script(account(900n), stored(change));
    const err = await rejection(
      debitWallet({
        accountId: ACCOUNT_ID,
        type: "usage",
        amount: 100n,
        idempotencyKey: "k",
      }),
    );
    expect(err.code).toBe("WAL_003");
  });
});

describe("input validation", () => {
  it.each([
    ["zero", 0n],
    ["negative", -1n],
    ["above the maximum", MAX_WALLET_AMOUNT + 1n],
    ["not a bigint", 5 as unknown as bigint],
  ])("rejects a %s amount before touching the database", async (_l, amount) => {
    const err = await rejection(
      creditWallet({
        accountId: ACCOUNT_ID,
        type: "topup",
        amount,
        idempotencyKey: "k",
      }),
    );
    expect(err.code).toBe("WAL_004");
    expect(state.transactions).toBe(0);
  });

  it("accepts the maximum amount", async () => {
    script(account(0n));
    await creditWallet({
      accountId: ACCOUNT_ID,
      type: "topup",
      amount: MAX_WALLET_AMOUNT,
      idempotencyKey: "k",
    });
    expect(state.inserts[0]).toMatchObject({ amount: MAX_WALLET_AMOUNT });
  });

  it.each(["", "x".repeat(256)])(
    "rejects the idempotency key %j",
    async (key) => {
      const err = await rejection(
        creditWallet({
          accountId: ACCOUNT_ID,
          type: "topup",
          amount: 1n,
          idempotencyKey: key,
        }),
      );
      expect(err.code).toBe("WAL_004");
      expect(state.transactions).toBe(0);
    },
  );
});
