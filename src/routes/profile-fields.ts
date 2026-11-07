import { z } from "zod";
import { isCountryCode } from "../countries.js";

/**
 * Single source of truth for the user profile fields exposed by both the
 * self-service profile route and the admin user route. Keeping the HTTP schema
 * and the DB update map together prevents one endpoint from silently drifting
 * away from the other (and from the Stripe Customer sync).
 */
export const USER_PROFILE_FIELDS = [
  "name",
  "firstName",
  "lastName",
  "username",
  "phone",
  "company",
  "position",
  "address",
  "postalCode",
  "city",
  "region",
  "country",
  "middleName",
  "profileUrl",
  "website",
  "gender",
  "birthdate",
  "zoneinfo",
  "locale",
  "image",
] as const;

export type UserProfileField = (typeof USER_PROFILE_FIELDS)[number];

export type UserProfileValues = {
  name: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  phone: string | null;
  company: string | null;
  position: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  middleName: string | null;
  profileUrl: string | null;
  website: string | null;
  gender: "female" | "male" | "other" | null;
  birthdate: string | null;
  zoneinfo: string | null;
  locale: string | null;
  image: string | null;
};

export type UserProfileUpdate = Partial<UserProfileValues>;

const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(isHttpUrl, { message: "Use an http(s) URL" })
  .nullable()
  .optional();

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export const profileFieldsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  firstName: nullableText(100),
  lastName: nullableText(100),
  username: nullableText(50),
  phone: z.string().max(30).nullable().optional(),
  company: z.string().max(100).nullable().optional(),
  position: z.string().max(100).nullable().optional(),
  address: z.string().max(200).nullable().optional(),
  postalCode: nullableText(20),
  city: nullableText(100),
  region: nullableText(100),
  country: z
    .string()
    .trim()
    .refine(isCountryCode, {
      message: "Use an ISO 3166-1 alpha-2 country code",
    })
    .transform((value) => value.toUpperCase())
    .nullable()
    .optional(),
  middleName: nullableText(100),
  profileUrl: httpUrl,
  website: httpUrl,
  gender: z.enum(["female", "male", "other"]).nullable().optional(),
  birthdate: z
    .string()
    .trim()
    .refine(isOidcBirthdate, {
      message: "Use YYYY, YYYY-MM-DD, or 0000 when unknown",
    })
    .nullable()
    .optional(),
  zoneinfo: nullableText(100),
  locale: z
    .string()
    .trim()
    .max(35)
    .refine((value) => {
      try {
        return Intl.getCanonicalLocales(value).length === 1;
      } catch {
        return false;
      }
    }, {
      message: "Use a BCP 47 language tag, e.g. fr-FR",
    })
    .nullable()
    .optional(),
  image: httpUrl,
});

/** Accept the OIDC birthdate forms: YYYY, YYYY-MM-DD, and 0000 for unknown. */
function isOidcBirthdate(value: string): boolean {
  const match = /^(\d{4})(?:-(\d{2})-(\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (month === undefined) return year === 0 || year >= 1;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Build the Drizzle `set` payload from the fields actually present in a PATCH. */
export function profileUpdateSet(data: UserProfileUpdate): UserProfileUpdate {
  return Object.fromEntries(
    USER_PROFILE_FIELDS.flatMap((field) =>
      data[field] === undefined ? [] : [[field, data[field]]],
    ),
  ) as UserProfileUpdate;
}

export function hasProfileChanges(data: UserProfileUpdate): boolean {
  return USER_PROFILE_FIELDS.some((field) => data[field] !== undefined);
}
