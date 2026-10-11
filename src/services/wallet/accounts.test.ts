import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    inserts: [] as Record<string, unknown>[],
  };
  const mockDb = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(state.selects.shift() ?? []),
      };
      return chain;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  return { mockDb, state };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { findWalletAccount, getOrCreateWalletAccount } =
  await import("./accounts.js");

const wallet = { id: "w1", ownerType: "user", ownerId: "u1", balance: 0n };

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
  state.inserts = [];
});

describe("findWalletAccount", () => {
  it("returns the wallet or undefined without creating one", async () => {
    state.selects.push([wallet], []);
    expect(await findWalletAccount("user", "u1")).toEqual(wallet);
    expect(await findWalletAccount("user", "u2")).toBeUndefined();
    expect(state.inserts).toHaveLength(0);
  });
});

describe("getOrCreateWalletAccount", () => {
  it("returns an existing wallet without verifying the owner or inserting", async () => {
    state.selects.push([wallet]);
    expect(await getOrCreateWalletAccount("user", "u1")).toEqual(wallet);
    expect(state.inserts).toHaveLength(0);
  });

  it("creates the wallet of an existing user", async () => {
    state.selects.push([], [{ id: "u1" }], [wallet]);
    expect(await getOrCreateWalletAccount("user", "u1")).toEqual(wallet);
    expect(state.inserts).toEqual([{ ownerType: "user", ownerId: "u1" }]);
  });

  it("creates the wallet of an existing organization", async () => {
    const orgWallet = { ...wallet, ownerType: "org", ownerId: "o1" };
    state.selects.push([], [{ id: "o1" }], [orgWallet]);
    expect(await getOrCreateWalletAccount("org", "o1")).toEqual(orgWallet);
    expect(state.inserts).toEqual([{ ownerType: "org", ownerId: "o1" }]);
  });

  it("rejects an unknown user without inserting", async () => {
    state.selects.push([], []);
    expect((await rejection(getOrCreateWalletAccount("user", "x"))).code).toBe(
      "USR_001",
    );
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects an unknown organization without inserting", async () => {
    state.selects.push([], []);
    expect((await rejection(getOrCreateWalletAccount("org", "x"))).code).toBe(
      "ORG_001",
    );
    expect(state.inserts).toHaveLength(0);
  });

  it("fails loudly when the wallet is still missing after creation", async () => {
    state.selects.push([], [{ id: "u1" }], []);
    expect((await rejection(getOrCreateWalletAccount("user", "u1"))).code).toBe(
      "WAL_001",
    );
  });
});
