import { config } from "../../config.js";
import { ERR } from "../../errors.js";

export interface UsdPricing {
  /** Decimal string, euros per US dollar. */
  usdToEurRate: string;
  /** Percentage added on top of the provider cost. */
  marginPercent: number;
}

const DECIMAL_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,18})?$/;
const MICRO_PER_EUR = 1_000_000n;

function parseDecimal(value: string): { units: bigint; scale: number } {
  if (!DECIMAL_RE.test(value)) {
    throw ERR.WAL_004("Cost must be a plain decimal number");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/** Pricing settings, or a 503 when the operator has not set the exchange rate. */
export function getUsdPricing(): UsdPricing {
  const { usdToEurRate, marginPercent } = config.wallet;
  if (!usdToEurRate) throw ERR.WAL_007();
  return { usdToEurRate, marginPercent };
}

/**
 * Price a provider cost in US dollars into micro-euros: exchange rate, then
 * margin. Exact integer arithmetic, rounded up, never below one micro-euro for
 * a positive cost, so a billable call is never free.
 */
export function usdToMicroEur(costUsd: string, pricing: UsdPricing): bigint {
  const cost = parseDecimal(costUsd);
  if (cost.units === 0n) {
    throw ERR.WAL_004("Cost must be greater than zero");
  }
  const rate = parseDecimal(pricing.usdToEurRate);

  const numerator =
    cost.units *
    rate.units *
    BigInt(100 + pricing.marginPercent) *
    MICRO_PER_EUR;
  const denominator = 100n * 10n ** BigInt(cost.scale + rate.scale);
  const priced = (numerator + denominator - 1n) / denominator;
  return priced > 0n ? priced : 1n;
}
