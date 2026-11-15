/**
 * Wallet amounts travel as strings of integer micro-euros (1 EUR = 1 000 000):
 * JSON has no 64-bit integer and floating point must never touch a price.
 * Parsing is exact; only display converts to a number.
 */

const MICRO_PER_EUR = 1_000_000n;
/** Backend ceiling for a single operation: 1 000 000 EUR. */
const MAX_EUR_DIGITS = 7;

/** Below one cent an amount needs more decimals to mean anything. */
const SMALL_THRESHOLD_MICRO = 10_000n;

export function formatMicroEur(micro: string | bigint, locale: string): string {
  const value = typeof micro === 'bigint' ? micro : BigInt(micro);
  const abs = value < 0n ? -value : value;
  const small = abs !== 0n && abs < SMALL_THRESHOLD_MICRO;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: small ? 4 : 2,
    maximumFractionDigits: small ? 6 : 2,
  }).format(Number(value) / Number(MICRO_PER_EUR));
}

/**
 * Parse an amount typed in euros ("12", "12.5", "12,50", "0.000123") into a
 * micro-euro string. Returns null for anything else: no exponent, no more than
 * six decimals, no zero, and a minus sign only when `allowNegative` is set.
 */
export function parseEurToMicro(
  input: string,
  options: { allowNegative?: boolean } = {},
): string | null {
  const match = new RegExp(`^(-?)(\\d{1,${MAX_EUR_DIGITS}})(?:[.,](\\d{1,6}))?$`).exec(
    input.trim(),
  );
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  if (sign && !options.allowNegative) return null;
  const micro = BigInt(whole!) * MICRO_PER_EUR + BigInt(fraction.padEnd(6, '0'));
  if (micro === 0n) return null;
  return (sign ? -micro : micro).toString();
}

/** Euro cents for Stripe: whole cents only. */
export function eurToCents(input: string): number | null {
  const micro = parseEurToMicro(input);
  if (micro === null) return null;
  const value = BigInt(micro);
  if (value % 10_000n !== 0n) return null;
  return Number(value / 10_000n);
}

/**
 * Micro-euros charged for one US dollar of provider cost: the exchange rate
 * (a plain decimal, up to 8 decimals), then the margin, rounded up.
 */
export function pricedOneDollar(rate: string, marginPercent: number): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  const units = BigInt(whole + fraction);
  const numerator = units * BigInt(100 + marginPercent) * MICRO_PER_EUR;
  const denominator = 100n * 10n ** BigInt(fraction.length);
  return (numerator + denominator - 1n) / denominator;
}

/** A positive exchange rate typed with a point or a comma, normalised; null otherwise. */
export function parseRate(input: string): string | null {
  const value = input.trim().replace(',', '.');
  if (!/^[0-9]{1,3}(\.[0-9]{1,8})?$/.test(value)) return null;
  return Number(value) > 0 ? value : null;
}

// Stripe amounts are integer minor units. Most currencies use two decimals,
// but some use none or three; dividing everything by 100 misprices them.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export function currencyExponent(currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function formatMinorAmount(
  minor: number,
  currency: string,
  options: { locale?: string; minimumFractionDigits?: number } = {},
): string {
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(options.locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    // Never show more decimals than the currency has, even if a caller asks.
    minimumFractionDigits: Math.min(
      options.minimumFractionDigits ?? exponent,
      exponent,
    ),
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent);
}
