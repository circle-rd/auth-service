import { randomBytes } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { generateId } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { account, user as userTable } from "../db/auth-schema.js";
import { logger } from "../logger.js";
import { encodeLegacyHash, legacyHashSchema } from "./legacy-password.js";

// Identifier of the account at the provider the user comes from, kept as the
// token `sub` so applications keyed on it need no mapping (`00u…`,
// `auth0|…`, a UUID). Printable ASCII without spaces.
const externalIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, "id must be printable ASCII without spaces");

const importUserRowSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email(),
    // Optional: when omitted the server generates a temporary password and
    // returns it once so the operator can hand it over.
    password: z.string().min(8).optional(),
    role: z.enum(["user", "admin"]).default("user"),
    // Superadmin only: these fields set what a user is trusted to be.
    id: externalIdSchema.optional(),
    emailVerified: z.boolean().optional(),
    passwordHash: legacyHashSchema.optional(),
  })
  .refine((row) => !(row.password && row.passwordHash), {
    message: "send either password or passwordHash, not both",
  });

export const importUsersSchema = z.object({
  users: z.array(importUserRowSchema).min(1).max(500),
  // Verification e-mails are sent to unverified rows when mail is configured.
  sendVerification: z.boolean().default(true),
});
export type ImportUsersInput = z.infer<typeof importUsersSchema>;

export interface ImportRowResult {
  email: string;
  status: "created" | "error";
  message?: string;
  /** Only returned when no password nor hash was supplied. */
  password?: string;
}

/** 12-char URL-safe temporary password (min length is 8). */
function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

function isUniqueViolation(err: unknown): boolean {
  const code = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  // Drizzle wraps the driver error and keeps it as `cause`.
  return (
    code(err) === "23505" ||
    code((err as { cause?: unknown } | null)?.cause) === "23505"
  );
}

type ImportRow = ImportUsersInput["users"][number];

const needsSuperadmin = (row: ImportRow) =>
  row.id !== undefined ||
  row.emailVerified !== undefined ||
  row.passwordHash !== undefined;

/**
 * Create a user with an explicit id, verification state or imported password
 * hash. BetterAuth's createUser cannot set these, so the rows are written
 * directly, in one transaction.
 */
async function createTrustedUser(row: ImportRow, email: string) {
  const id = row.id ?? generateId();
  const now = new Date();
  let temporaryPassword: string | undefined;
  let stored: string;
  if (row.passwordHash) {
    stored = encodeLegacyHash(row.passwordHash);
  } else if (row.password) {
    stored = await hashPassword(row.password);
  } else {
    temporaryPassword = generateTempPassword();
    stored = await hashPassword(temporaryPassword);
  }
  await db.transaction(async (tx) => {
    await tx.insert(userTable).values({
      id,
      name: row.name,
      email,
      emailVerified: row.emailVerified ?? false,
      role: row.role,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(account).values({
      id: generateId(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: stored,
      createdAt: now,
      updatedAt: now,
    });
  });
  return temporaryPassword;
}

/**
 * Bulk-create users. Plain rows go through BetterAuth; rows that carry an id,
 * a verification state or a password hash are reserved to superadmins and
 * written directly. Each row succeeds or fails on its own.
 */
export async function importUsers(opts: {
  input: ImportUsersInput;
  callerRole: string;
  callerId: string | null;
  headers: IncomingHttpHeaders;
  mailConfigured: boolean;
}): Promise<{ results: ImportRowResult[]; created: number; failed: number }> {
  const { input, callerRole, mailConfigured } = opts;
  const results: ImportRowResult[] = [];

  for (const row of input.users) {
    const email = row.email.toLowerCase();
    const fail = (message: string) =>
      results.push({ email, status: "error", message });

    if (row.role === "admin" && callerRole !== "superadmin") {
      fail("Only superadmins can create admin users");
      continue;
    }
    if (needsSuperadmin(row) && callerRole !== "superadmin") {
      fail(
        "Only superadmins can import ids, verified addresses or password hashes",
      );
      continue;
    }

    try {
      let temporaryPassword: string | undefined;
      if (needsSuperadmin(row)) {
        temporaryPassword = await createTrustedUser(row, email);
      } else {
        const password = row.password ?? generateTempPassword();
        await auth.api.createUser({
          headers: fromNodeHeaders(opts.headers),
          // Only an explicit admin row carries a role, and only a superadmin
          // reaches this point with one: the native endpoint demands
          // `user:set-role` as soon as a role is present.
          body: {
            name: row.name,
            email,
            password,
            ...(row.role === "admin" ? { role: row.role } : {}),
          },
        });
        if (!row.password) temporaryPassword = password;
      }

      const verified = row.emailVerified === true;
      if (mailConfigured && input.sendVerification && !verified) {
        void auth.api
          .sendVerificationEmail({ body: { email } })
          .catch((err) =>
            logger.warn(
              { err: String(err), email },
              "[admin] failed to send verification email during import",
            ),
          );
      }
      results.push({
        email,
        status: "created",
        ...(temporaryPassword ? { password: temporaryPassword } : {}),
      });
    } catch (err) {
      fail(
        isUniqueViolation(err)
          ? "User already exists. Use another email or id."
          : err instanceof Error
            ? err.message
            : "Failed to create user",
      );
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  if (input.users.some(needsSuperadmin)) {
    logger.info(
      { actor: opts.callerId, created, failed: results.length - created },
      "[admin] trusted user import",
    );
  }
  return { results, created, failed: results.length - created };
}
