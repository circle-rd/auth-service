import { describe, expect, it } from "vitest";
import { toAccountView, toTransactionView } from "./views.js";

describe("wallet views", () => {
  it("serialises amounts as strings so they survive JSON", () => {
    const view = toAccountView({
      balance: 9_007_199_254_740_993n,
      isUnlimited: false,
    });
    expect(view).toEqual({
      balance: "9007199254740993",
      isUnlimited: false,
      currency: "eur",
    });
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it("exposes a transaction without its idempotency key or account", () => {
    const createdAt = new Date("2026-10-09T10:00:00.123Z");
    const view = toTransactionView({
      id: "t1",
      type: "usage",
      amount: -5n,
      delta: 0n,
      balanceAfter: 100n,
      applicationId: null,
      metadata: { model: "m" },
      createdAt,
    });
    expect(view).toEqual({
      id: "t1",
      type: "usage",
      amount: "-5",
      delta: "0",
      balanceAfter: "100",
      applicationId: null,
      metadata: { model: "m" },
      createdAt: "2026-10-09T10:00:00.123Z",
    });
    expect(() => JSON.stringify(view)).not.toThrow();
  });
});
