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
  image: string | null;
};

export type UserProfileUpdate = Partial<UserProfileValues>;

const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

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
  image: z.string().url().nullable().optional(),
});

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
