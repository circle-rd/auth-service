import { describe, expect, it } from "vitest";
import { monthlyEquivalent } from "./mrr.js";

describe("monthlyEquivalent", () => {
  it("prefers the monthly price", () => {
    expect(
      monthlyEquivalent(
        [
          { amount: 12000, currency: "eur", interval: "year" },
          { amount: 1200, currency: "eur", interval: "month" },
        ],
        "eur",
      ),
    ).toBe(1200);
  });

  it("spreads a yearly price over twelve months", () => {
    expect(
      monthlyEquivalent(
        [{ amount: 10000, currency: "eur", interval: "year" }],
        "eur",
      ),
    ).toBe(833);
  });

  it("ignores other currencies and one-off prices", () => {
    expect(
      monthlyEquivalent(
        [
          { amount: 900, currency: "usd", interval: "month" },
          { amount: 5000, currency: "eur", interval: "one_time" },
        ],
        "eur",
      ),
    ).toBeNull();
  });
});
