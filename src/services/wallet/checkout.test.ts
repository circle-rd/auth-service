import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { holder, mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return {
    mockCreate,
    holder: {
      stripe: { checkout: { sessions: { create: mockCreate } } } as unknown,
    },
  };
});

vi.mock("../stripe.js", () => ({
  get stripe() {
    return holder.stripe;
  },
}));

const { createTopupCheckout, getTopupOptions, CENTS_TO_MICRO } =
  await import("./checkout.js");
const { config } = await import("../../config.js");

const stripeClient = holder.stripe;

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeEach(() => {
  holder.stripe = stripeClient;
  mockCreate
    .mockReset()
    .mockResolvedValue({ url: "https://checkout.stripe.test/s" });
});

describe("getTopupOptions", () => {
  it("reports whether online payment is available, with the configured bounds", () => {
    expect(getTopupOptions()).toEqual({
      enabled: true,
      currency: "eur",
      minCents: config.wallet.minTopupCents,
      maxCents: config.wallet.maxTopupCents,
    });
    holder.stripe = null;
    expect(getTopupOptions().enabled).toBe(false);
  });
});

describe("createTopupCheckout", () => {
  it("opens a one-time euro payment and records the credit to grant", async () => {
    const result = await createTopupCheckout({
      userId: "u1",
      email: "u1@example.com",
      amountCents: 1000,
    });
    expect(result).toEqual({ url: "https://checkout.stripe.test/s" });

    const params = mockCreate.mock.calls[0]![0];
    expect(params).toMatchObject({
      mode: "payment",
      client_reference_id: "u1",
      customer_email: "u1@example.com",
      adaptive_pricing: { enabled: true },
      line_items: [
        { quantity: 1, price_data: { currency: "eur", unit_amount: 1000 } },
      ],
    });
    const expectedMetadata = {
      purpose: "wallet_topup",
      userId: "u1",
      creditMicro: (1000n * CENTS_TO_MICRO).toString(),
    };
    expect(params.metadata).toEqual(expectedMetadata);
    expect(params.payment_intent_data.metadata).toEqual(expectedMetadata);
    expect(params.success_url).toBe(
      `${config.betterAuth.url}/wallet?topup=success`,
    );
    expect(params.cancel_url).toBe(
      `${config.betterAuth.url}/wallet?topup=cancelled`,
    );
  });

  it("converts cents to micro-euros exactly", () => {
    expect(100n * CENTS_TO_MICRO).toBe(1_000_000n);
  });

  it("omits the customer email when the user has none", async () => {
    await createTopupCheckout({ userId: "u1", email: null, amountCents: 1000 });
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty("customer_email");
  });

  it("answers 503 when Stripe is not configured and calls nothing", async () => {
    holder.stripe = null;
    const err = await rejection(
      createTopupCheckout({ userId: "u1", email: null, amountCents: 1000 }),
    );
    expect(err.code).toBe("WAL_006");
    expect(err.statusCode).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["below the minimum", () => config.wallet.minTopupCents - 1],
    ["above the maximum", () => config.wallet.maxTopupCents + 1],
  ])("rejects an amount %s", async (_label, amount) => {
    const err = await rejection(
      createTopupCheckout({ userId: "u1", email: null, amountCents: amount() }),
    );
    expect(err.code).toBe("WAL_004");
    expect(err.details).toEqual({
      minCents: config.wallet.minTopupCents,
      maxCents: config.wallet.maxTopupCents,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("accepts both bounds", async () => {
    await createTopupCheckout({
      userId: "u1",
      email: null,
      amountCents: config.wallet.minTopupCents,
    });
    await createTopupCheckout({
      userId: "u1",
      email: null,
      amountCents: config.wallet.maxTopupCents,
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when Stripe returns no URL", async () => {
    mockCreate.mockResolvedValue({ url: null });
    const err = await rejection(
      createTopupCheckout({ userId: "u1", email: null, amountCents: 1000 }),
    );
    expect(err.code).toBe("SRV_001");
  });
});
