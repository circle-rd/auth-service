const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

/** True for an ISO 3166-1 alpha-2 country code, ignoring surrounding spaces. */
export function isCountryCode(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && COUNTRY_CODE_RE.test(value.trim());
}

/** Uppercase, canonical country code, or null when the value is not usable. */
export function normalizeCountryCode(
  value: string | null | undefined,
): string | null {
  return isCountryCode(value) ? value.trim().toUpperCase() : null;
}
