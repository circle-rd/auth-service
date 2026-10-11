import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { wallet: { usdToEurRate: "0.90", marginPercent: 10 } },
}));
vi.mock("../../config.js", () => ({ config: mockConfig }));

const { getUsdPricing, usdToMicroEur } = await import("./pricing.js");

const pricing = (rate: string, marginPercent = 0) => ({
  usdToEurRate: rate,
  marginPercent,
});

function failure(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error("expected a failure");
}

describe("usdToMicroEur", () => {
  it.each([
    ["1", "1", 0, 1_000_000n],
    ["1", "0.92", 0, 920_000n],
    ["0.001", "0.92", 0, 920n],
    ["0.001", "0.90", 10, 990n],
    ["2.5", "1", 100, 5_000_000n],
  ])(
    "prices $%s at rate %s with %i%% margin into %s micro-euros",
    (usd, rate, margin, expected) => {
      expect(usdToMicroEur(usd, pricing(rate, margin))).toBe(expected);
    },
  );

  it("rounds up to the next micro-euro", () => {
    // 0.0000011 USD × 1 = 1.1 micro-euros → 2
    expect(usdToMicroEur("0.0000011", pricing("1"))).toBe(2n);
  });

  it("never prices a positive cost at zero", () => {
    expect(usdToMicroEur("0.000000000000000001", pricing("0.01"))).toBe(1n);
  });

  it("stays exact on costs that floating point cannot represent", () => {
    expect(usdToMicroEur("0.1", pricing("3"))).toBe(300_000n);
    expect(usdToMicroEur("0.000123456789012345", pricing("1"))).toBe(124n);
  });

  it("handles large costs", () => {
    expect(usdToMicroEur("999999999999", pricing("1"))).toBe(
      999_999_999_999_000_000n,
    );
  });

  it.each(["0", "0.0", "0.000000"])("rejects a zero cost (%s)", (cost) => {
    expect(failure(() => usdToMicroEur(cost, pricing("1"))).code).toBe(
      "WAL_004",
    );
  });

  it.each([
    "-1",
    "1e-3",
    "abc",
    "",
    "1.",
    ".5",
    "1,5",
    "0x10",
    "0.1234567890123456789",
    "1234567890123",
  ])("rejects the malformed cost %j", (cost) => {
    expect(failure(() => usdToMicroEur(cost, pricing("1"))).code).toBe(
      "WAL_004",
    );
  });
});

describe("getUsdPricing", () => {
  it("returns the configured rate and margin", () => {
    expect(getUsdPricing()).toEqual({
      usdToEurRate: "0.90",
      marginPercent: 10,
    });
  });

  it("answers 503 when the rate is not configured", () => {
    mockConfig.wallet.usdToEurRate = undefined as unknown as string;
    const err = failure(() => getUsdPricing());
    expect(err.code).toBe("WAL_007");
    expect(err.statusCode).toBe(503);
    mockConfig.wallet.usdToEurRate = "0.90";
  });
});
