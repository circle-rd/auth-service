import { z } from "zod";

export const organizationNameSchema = z.string().min(1).max(100);

export const organizationSlugSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9-]+$/);

/** `team` filter of the listings: the query string is `true` or `false`. */
export const teamFilterSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
