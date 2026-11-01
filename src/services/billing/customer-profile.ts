import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { organization, user } from "../../db/auth-schema.js";
import { ERR } from "../../errors.js";
import type { OwnerType } from "../owners.js";
import { normalizeCountryCode } from "../../countries.js";

/** The Stripe Customer fields auth-service can qualify from its own data. */
export interface CustomerProfile {
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  address: Stripe.AddressParam | null;
  metadata: Record<string, string>;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function personName(input: {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
}): string | null {
  const structured = [clean(input.firstName), clean(input.lastName)]
    .filter((part): part is string => part !== null)
    .join(" ");
  return structured || clean(input.name);
}

function personDescription(input: {
  position: string | null;
  company: string | null;
}): string | null {
  const position = clean(input.position);
  const company = clean(input.company);
  if (position && company) return `${position} at ${company}`;
  return position ?? company;
}

function postalAddress(input: {
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}): Stripe.AddressParam | null {
  // Stripe requires an ISO 3166-1 alpha-2 country code; never send free text.
  const country = clean(input.country);
  const address: Stripe.AddressParam = {
    ...(clean(input.address) ? { line1: clean(input.address)! } : {}),
    ...(clean(input.city) ? { city: clean(input.city)! } : {}),
    ...(clean(input.region) ? { state: clean(input.region)! } : {}),
    ...(clean(input.postalCode)
      ? { postal_code: clean(input.postalCode)! }
      : {}),
    ...(country && /^[A-Za-z]{2}$/.test(country)
      ? { country: country.toUpperCase() }
      : {}),
  };
  return Object.keys(address).length > 0 ? address : null;
}

function addMetadata(
  target: Record<string, string>,
  key: string,
  value: string | null,
): void {
  if (value) target[key] = value.slice(0, 500);
}

/** Load the local profile of a Stripe Customer owner, failing on a missing row. */
export async function loadCustomerProfile(
  ownerType: OwnerType,
  ownerId: string,
): Promise<CustomerProfile> {
  if (ownerType === "user") {
    const [row] = await db
      .select({
        name: user.name,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        company: user.company,
        position: user.position,
        address: user.address,
        postalCode: user.postalCode,
        city: user.city,
        region: user.region,
        country: user.country,
      })
      .from(user)
      .where(eq(user.id, ownerId))
      .limit(1);
    if (!row) throw ERR.USR_001();

    const metadata: Record<string, string> = { ownerType, ownerId };
    addMetadata(metadata, "username", clean(row.username));
    addMetadata(metadata, "company", clean(row.company));
    addMetadata(metadata, "position", clean(row.position));
    addMetadata(metadata, "country", normalizeCountryCode(row.country));

    return {
      name: personName(row),
      email: clean(row.email),
      phone: clean(row.phone),
      description: personDescription(row),
      address: postalAddress(row),
      metadata,
    };
  }

  const [row] = await db
    .select({
      name: organization.name,
      slug: organization.slug,
      domain: organization.domain,
    })
    .from(organization)
    .where(eq(organization.id, ownerId))
    .limit(1);
  if (!row) throw ERR.ORG_001();

  const metadata: Record<string, string> = { ownerType, ownerId };
  addMetadata(metadata, "organizationSlug", clean(row.slug));
  addMetadata(metadata, "domain", clean(row.domain));

  return {
    name: clean(row.name),
    email: null,
    phone: null,
    description: clean(row.domain),
    address: null,
    metadata,
  };
}

/** Create parameters for a Customer, including every field the profile knows. */
export function customerCreateParams(
  profile: CustomerProfile,
): Stripe.CustomerCreateParams {
  return {
    metadata: profile.metadata,
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.phone ? { phone: profile.phone } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.address ? { address: profile.address } : {}),
  };
}

/**
 * Update parameters for an existing Customer. Stripe treats an empty string as
 * "clear this field", so a value removed from the local profile is removed from
 * the Dashboard too (metadata keys included).
 */
export function customerUpdateParams(
  profile: CustomerProfile,
): Stripe.CustomerUpdateParams {
  const metadata: Record<string, string> = {
    ownerType: profile.metadata.ownerType ?? "",
    ownerId: profile.metadata.ownerId ?? "",
  };
  const clearing =
    profile.metadata.ownerType === "org"
      ? ["organizationSlug", "domain"]
      : ["username", "company", "position", "country"];
  for (const key of clearing) {
    metadata[key] = profile.metadata[key] ?? "";
  }
  return {
    metadata,
    name: profile.name ?? "",
    email: profile.email ?? "",
    phone: profile.phone ?? "",
    description: profile.description ?? "",
    address: profile.address ?? "",
  };
}

function valueOrEmpty(value: string | null | undefined): string {
  return value ?? "";
}

/** True when the Stripe Customer already matches the local profile. */
export function customerMatchesProfile(
  customer: Stripe.Customer,
  profile: CustomerProfile,
): boolean {
  const address = (customer.address ?? {}) as Partial<Stripe.Address>;
  const expected = (profile.address ?? {}) as Partial<Stripe.AddressParam>;
  const metadataKeys: string[] = [
    "ownerType",
    "ownerId",
    ...(profile.metadata.ownerType === "org"
      ? ["organizationSlug", "domain"]
      : ["username", "company", "position", "country"]),
  ];

  return (
    valueOrEmpty(customer.name) === valueOrEmpty(profile.name) &&
    valueOrEmpty(customer.email) === valueOrEmpty(profile.email) &&
    valueOrEmpty(customer.phone) === valueOrEmpty(profile.phone) &&
    valueOrEmpty(customer.description) === valueOrEmpty(profile.description) &&
    valueOrEmpty(address.line1) === valueOrEmpty(expected.line1) &&
    valueOrEmpty(address.city) === valueOrEmpty(expected.city) &&
    valueOrEmpty(address.state) === valueOrEmpty(expected.state) &&
    valueOrEmpty(address.postal_code) === valueOrEmpty(expected.postal_code) &&
    valueOrEmpty(address.country) === valueOrEmpty(expected.country) &&
    metadataKeys.every(
      (key) =>
        valueOrEmpty(customer.metadata?.[key]) ===
        valueOrEmpty(profile.metadata[key]),
    )
  );
}
