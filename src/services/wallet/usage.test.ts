import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockDebit, state } = vi.hoisted(() => {
  const state = { app: [] as unknown[], lookups: 0 };
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => {
      state.lookups += 1;
      return Promise.resolve(state.app);
    },
  };
  return { mockDb: { select: () => chain }, mockDebit: vi.fn(), state };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("./ledger.js", () => ({ debitWallet: mockDebit }));

const { recordUsage } = await import("./usage.js");

beforeEach(() => {
  state.app = [];
  state.lookups = 0;
  mockDebit.mockReset();
  mockDebit.mockResolvedValue({ transaction: { id: "t" }, replayed: false });
});

describe("recordUsage", () => {
  it("debits usage and links the application it resolved from the slug", async () => {
    state.app = [{ id: "app-1" }];
    await recordUsage({
      accountId: "acc",
      amount: 7n,
      idempotencyKey: "k",
      applicationSlug: "my-app",
      metadata: { model: "m" },
    });
    expect(mockDebit).toHaveBeenCalledWith({
      accountId: "acc",
      type: "usage",
      amount: 7n,
      idempotencyKey: "k",
      applicationId: "app-1",
      metadata: { model: "m", applicationSlug: "my-app" },
    });
  });

  it("still debits when the application no longer exists, keeping the slug", async () => {
    await recordUsage({
      accountId: "acc",
      amount: 7n,
      idempotencyKey: "k",
      applicationSlug: "gone",
    });
    expect(mockDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: undefined,
        metadata: { applicationSlug: "gone" },
      }),
    );
  });

  it("skips the application lookup when no slug is given", async () => {
    await recordUsage({ accountId: "acc", amount: 7n, idempotencyKey: "k" });
    expect(state.lookups).toBe(0);
    expect(mockDebit).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: undefined, metadata: {} }),
    );
  });

  it("lets the server-side slug win over a metadata key of the same name", async () => {
    await recordUsage({
      accountId: "acc",
      amount: 1n,
      idempotencyKey: "k",
      applicationSlug: "real",
      metadata: { applicationSlug: "spoofed" },
    });
    expect(mockDebit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { applicationSlug: "real" } }),
    );
  });
});
