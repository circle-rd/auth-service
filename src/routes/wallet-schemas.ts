import { z } from "zod";
import {
  MAX_PAGE_SIZE,
  WALLET_TRANSACTION_TYPES,
} from "../services/wallet/index.js";

// Amounts travel as integer strings of micro-euros: JSON numbers cannot carry a
// bigint without losing precision.
export const positiveAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, "amount must be a positive integer string")
  .transform((v) => BigInt(v));

export const signedAmountSchema = z
  .string()
  .regex(/^-?[1-9][0-9]{0,18}$/, "amount must be a non-zero integer string")
  .transform((v) => BigInt(v));

// Provider cost in US dollars as a plain decimal string, never a float.
export const positiveDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,18})?$/, "must be a plain decimal")
  .refine((v) => /[1-9]/.test(v), "must be greater than zero");

export const idempotencyKeySchema = z.string().min(1).max(255);

export const reasonSchema = z.string().trim().min(1).max(500);

export const userParamsSchema = z.object({
  userId: z.string().min(1).max(255),
});

export const usageMetadataSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((m) => Object.keys(m).length <= 32, "at most 32 metadata entries");

export const statsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const listWalletsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  filter: z.enum(["all", "debt", "credit", "unlimited"]).default("all"),
});

export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).max(512).optional(),
  type: z.enum(WALLET_TRANSACTION_TYPES).optional(),
});

export const usageLedgerQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
    cursor: z.string().min(1).max(512).optional(),
  })
  .refine((q) => q.from < q.to, "from must be before to");
