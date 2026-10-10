import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    account: [] as unknown[],
    updates: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
  };
  const tx = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        for: () => chain,
        limit: () => Promise.resolve(state.account),
      };
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.updates.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: "acc", ...values }]),
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.events.push(values);
        return Promise.resolve();
      },
    }),
  };
  return {
    mockDb: { transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    state,
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { setWalletUnlimited } = await import("./unlimited.js");

const input = { accountId: "acc", actorId: "root", reason: "staff" };

beforeEach(() => {
  state.account = [{ id: "acc", isUnlimited: false }];
  state.updates = [];
  state.events = [];
});

describe("setWalletUnlimited", () => {
  it("enables the flag and audits the change with its reason", async () => {
    const result = await setWalletUnlimited({ ...input, isUnlimited: true });
    expect(result).toMatchObject({ isUnlimited: true });
    expect(state.events).toEqual([
      {
        accountId: "acc",
        actorUserId: "root",
        action: "unlimited_enabled",
        details: { reason: "staff" },
      },
    ]);
  });

  it("audits a disabling as its own action", async () => {
    state.account = [{ id: "acc", isUnlimited: true }];
    await setWalletUnlimited({ ...input, isUnlimited: false });
    expect(state.events[0]).toMatchObject({ action: "unlimited_disabled" });
  });

  it("is a silent no-op when the value is unchanged", async () => {
    state.account = [{ id: "acc", isUnlimited: true }];
    const result = await setWalletUnlimited({ ...input, isUnlimited: true });
    expect(result).toMatchObject({ id: "acc", isUnlimited: true });
    expect(state.updates).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("rejects an unknown account", async () => {
    state.account = [];
    const err = await setWalletUnlimited({ ...input, isUnlimited: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("WAL_001");
  });
});
