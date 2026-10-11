import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const { mockDb, mockGetOrCreate, mockCredit, mockDebit, state } = vi.hoisted(
  () => {
    const state = { selects: [] as unknown[][], executes: 0 };
    const chain = (): Record<string, unknown> => {
      const rows = state.selects.shift() ?? [];
      const c: Record<string, unknown> = {
        from: () => c,
        where: () => c,
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve),
      };
      return c;
    };
    const tx = {
      execute: () => {
        state.executes += 1;
        return Promise.resolve();
      },
      select: chain,
    };
    return {
      mockDb: {
        transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
      mockGetOrCreate: vi.fn(),
      mockCredit: vi.fn(),
      mockDebit: vi.fn(),
      state,
    };
  },
);

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("./accounts.js", () => ({ getOrCreateWalletAccount: mockGetOrCreate }));
vi.mock("./ledger.js", () => ({
  creditWallet: mockCredit,
  debitWallet: mockDebit,
}));

const { handleWalletStripeEvent } = await import("./stripe-events.js");

const event = (type: string, object: unknown) =>
  ({ id: "evt", type, data: { object } }) as unknown as Stripe.Event;

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_1",
  payment_status: "paid",
  payment_intent: { id: "pi_1" },
  currency: "eur",
  amount_total: 1000,
  metadata: { purpose: "wallet_topup", userId: "u1", creditMicro: "10000000" },
  ...overrides,
});

beforeEach(() => {
  state.selects = [];
  state.executes = 0;
  mockGetOrCreate.mockReset().mockResolvedValue({ id: "acc" });
  mockCredit.mockReset();
  mockDebit.mockReset();
});

describe("checkout events", () => {
  it("credits a paid top-up with a per-session idempotency key", async () => {
    expect(
      await handleWalletStripeEvent(
        event("checkout.session.completed", session()),
      ),
    ).toBe(true);
    expect(mockGetOrCreate).toHaveBeenCalledWith("user", "u1");
    expect(mockCredit).toHaveBeenCalledWith({
      accountId: "acc",
      type: "topup",
      amount: 10_000_000n,
      idempotencyKey: "stripe:checkout:cs_1",
      metadata: {
        source: "stripe",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
        chargedCurrency: "eur",
        chargedAmount: 1000,
      },
    });
  });

  it("handles the asynchronous confirmation the same way", async () => {
    await handleWalletStripeEvent(
      event("checkout.session.async_payment_succeeded", session()),
    );
    expect(mockCredit).toHaveBeenCalledTimes(1);
  });

  it("does not credit before an asynchronous payment is confirmed", async () => {
    expect(
      await handleWalletStripeEvent(
        event(
          "checkout.session.completed",
          session({ payment_status: "unpaid" }),
        ),
      ),
    ).toBe(true);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("ignores sessions that are not wallet top-ups", async () => {
    expect(
      await handleWalletStripeEvent(
        event("checkout.session.completed", session({ metadata: null })),
      ),
    ).toBe(false);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("rejects malformed top-up metadata instead of guessing an amount", async () => {
    await expect(
      handleWalletStripeEvent(
        event(
          "checkout.session.completed",
          session({
            metadata: {
              purpose: "wallet_topup",
              userId: "u1",
              creditMicro: "0",
            },
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(mockCredit).not.toHaveBeenCalled();
  });
});

describe("reversals", () => {
  const charge = (
    refunded: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: "ch_1",
    payment_intent: "pi_1",
    amount_captured: 1000,
    amount_refunded: refunded,
    ...overrides,
  });
  const topupRow = { accountId: "acc", amount: 10_000_000n };

  it("reverses the refunded share under a lock, keyed by the refunded total", async () => {
    state.selects.push([topupRow], [{ total: "0" }]);
    expect(
      await handleWalletStripeEvent(event("charge.refunded", charge(250))),
    ).toBe(true);
    expect(state.executes).toBe(1);
    expect(mockDebit).toHaveBeenCalledWith({
      accountId: "acc",
      type: "reversal",
      amount: 2_500_000n,
      idempotencyKey: "stripe:refund:ch_1:250",
      metadata: {
        source: "stripe",
        reason: "refund",
        paymentIntentId: "pi_1",
        chargeId: "ch_1",
      },
    });
  });

  it("subtracts what was already reversed and caps at the credit", async () => {
    state.selects.push([topupRow], [{ total: "2500000" }]);
    await handleWalletStripeEvent(event("charge.refunded", charge(1000)));
    expect(mockDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7_500_000n }),
    );

    mockDebit.mockClear();
    state.selects.push([topupRow], [{ total: "0" }]);
    await handleWalletStripeEvent(event("charge.refunded", charge(5000)));
    expect(mockDebit).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10_000_000n }),
    );
  });

  it("does nothing when everything is already reversed", async () => {
    state.selects.push([topupRow], [{ total: "10000000" }]);
    expect(
      await handleWalletStripeEvent(event("charge.refunded", charge(1000))),
    ).toBe(true);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it("reverses the whole remaining credit for a dispute", async () => {
    state.selects.push([topupRow], [{ total: "1000000" }]);
    const dispute = {
      id: "dp_1",
      charge: { id: "ch_1" },
      payment_intent: "pi_1",
    };
    expect(
      await handleWalletStripeEvent(event("charge.dispute.created", dispute)),
    ).toBe(true);
    expect(mockDebit).toHaveBeenCalledWith({
      accountId: "acc",
      type: "reversal",
      amount: 9_000_000n,
      idempotencyKey: "stripe:dispute:dp_1",
      metadata: {
        source: "stripe",
        reason: "dispute",
        paymentIntentId: "pi_1",
        chargeId: "ch_1",
      },
    });
  });

  it("is not about the wallet when no top-up matches the payment", async () => {
    state.selects.push([]);
    expect(
      await handleWalletStripeEvent(event("charge.refunded", charge(1000))),
    ).toBe(false);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a charge without payment intent",
      "charge.refunded",
      charge(1000, { payment_intent: null }),
    ],
    [
      "an uncaptured charge",
      "charge.refunded",
      charge(0, { amount_captured: 0 }),
    ],
    [
      "a dispute without payment intent",
      "charge.dispute.created",
      { id: "dp", charge: "ch", payment_intent: null },
    ],
  ])("ignores %s", async (_label, type, object) => {
    expect(await handleWalletStripeEvent(event(type, object))).toBe(false);
    expect(state.executes).toBe(0);
  });

  it("does not claim unrelated events", async () => {
    expect(
      await handleWalletStripeEvent(event("invoice.payment_succeeded", {})),
    ).toBe(false);
  });
});
