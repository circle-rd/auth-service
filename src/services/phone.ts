import { z } from "zod";

/**
 * Accept the common human formats (`+33 6 12 34 56 78`, `06.12.34.56.78`,
 * `0033-6-12-34-56-78`) and store one separator-free value. The local `0`
 * prefix is preserved because the service has no reliable country context to
 * expand it; consumers that need E.164 can normalise it themselves.
 */
export function normalizePhoneNumber(value: string): string | null {
  const compact = value
    .trim()
    .replace(/[\s\u00a0.\-()/]/g, "")
    .replace(/^00/, "+");
  if (!/^\+?[0-9]{6,15}$/.test(compact)) return null;
  return compact;
}

export const phoneNumberSchema = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const normalized = normalizePhoneNumber(value);
    if (!normalized) {
      ctx.addIssue({
        code: "custom",
        message:
          "Use 6 to 15 digits, optionally prefixed by + (spaces, dots and dashes are ignored)",
      });
      return z.NEVER;
    }
    return normalized;
  });

/** Clear a phone proof when the number changes. Shared by self-service and admin edits. */
export function phoneVerificationResetSet(): {
  phoneVerified: false;
  phoneVerifiedAt: null;
  phoneVerificationMethod: null;
} {
  return {
    phoneVerified: false,
    phoneVerifiedAt: null,
    phoneVerificationMethod: null,
  };
}
