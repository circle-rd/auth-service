import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCredit, mockDebit } = vi.hoisted(() => ({
  mockCredit: vi.fn(),
  mockDebit: vi.fn(),
}));

vi.mock("./ledger.js", () => ({
  creditWallet: mockCredit,
  debitWallet: mockDebit,
}));

const { grantCredit, adjustBalance } = await import("./adjustments.js");

const base = {
  accountId: "acc",
  idempotencyKey: "k",
  actorId: "admin-1",
  reason: "why",
};

beforeEach(() => {
  mockCredit.mockReset();
  mockDebit.mockReset();
});

describe("grantCredit", () => {
  it("credits a grant carrying the actor and the reason", async () => {
    await grantCredit({ ...base, amount: 50n });
    expect(mockCredit).toHaveBeenCalledWith({
      accountId: "acc",
      type: "grant",
      amount: 50n,
      idempotencyKey: "k",
      metadata: { actorId: "admin-1", reason: "why" },
    });
    expect(mockDebit).not.toHaveBeenCalled();
  });
});

describe("adjustBalance", () => {
  it("credits a positive adjustment", async () => {
    await adjustBalance({ ...base, amount: 30n });
    expect(mockCredit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "adjust", amount: 30n }),
    );
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it("debits the absolute value of a negative adjustment", async () => {
    await adjustBalance({ ...base, amount: -30n });
    expect(mockDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "adjust",
        amount: 30n,
        metadata: { actorId: "admin-1", reason: "why" },
      }),
    );
    expect(mockCredit).not.toHaveBeenCalled();
  });
});
