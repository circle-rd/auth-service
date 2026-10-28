/**
 * Maps a social provider profile onto the additional user fields declared in
 * `auth.ts`. Provider payloads use different, sometimes optional, keys; only
 * values the provider actually returns are copied (never inferred), so a
 * missing field stays missing instead of being guessed.
 */

type UserProfileFields = Record<string, string>;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** GitHub has a single free-form `name`; split on whitespace as a last resort. */
export function splitFullName(name: string | undefined): {
  firstName?: string;
  lastName?: string;
} {
  if (!name) return {};
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** `@acme` is a common GitHub company value, but Stripe metadata wants `acme`. */
function companyName(value: unknown): string | undefined {
  const raw = text(value);
  return raw?.replace(/^@+/, "").trim() || undefined;
}

/** Google ID-token claims: given_name/family_name/name/picture/email. */
export function mapGoogleProfile(profile: unknown): UserProfileFields {
  const source = (profile ?? {}) as Record<string, unknown>;
  const givenName = text(source.given_name);
  const familyName = text(source.family_name);
  const combined = [givenName, familyName].filter(Boolean).join(" ");
  const fullName = text(source.name) ?? (combined || undefined);

  return {
    ...(fullName ? { name: fullName } : {}),
    ...(givenName ? { firstName: givenName } : {}),
    ...(familyName ? { lastName: familyName } : {}),
  };
}

/**
 * GitHub `/user` payload: `login` is the username, `name` is free-form,
 * `company` is a display string and `location` is unstructured text (not a
 * postal address), so it is deliberately not copied into address fields.
 */
export function mapGitHubProfile(profile: unknown): UserProfileFields {
  const source = (profile ?? {}) as Record<string, unknown>;
  const fullName = text(source.name);
  const { firstName, lastName } = splitFullName(fullName);
  const username = text(source.login);
  const company = companyName(source.company);

  return {
    ...(fullName ? { name: fullName } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(username ? { username } : {}),
    ...(company ? { company } : {}),
  };
}
