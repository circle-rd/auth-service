import { pbkdf2, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { account } from "../db/auth-schema.js";
import { logger } from "../logger.js";

const pbkdf2Async = promisify(pbkdf2);

// Bounds keep a stored hash from turning a sign-in into a denial of service.
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Password hashes of another identity provider, accepted at import time so
 * that users keep their password. Only algorithms Node can verify with a
 * fixed, bounded cost are listed.
 */
export const legacyHashSchema = z.discriminatedUnion("algorithm", [
  z.object({
    algorithm: z.literal("bcrypt"),
    hash: z.string().regex(BCRYPT_RE, "not a bcrypt hash"),
  }),
  z.object({
    algorithm: z.literal("pbkdf2"),
    digest: z.enum(["sha256", "sha512"]),
    iterations: z.number().int().min(1).max(MAX_PBKDF2_ITERATIONS),
    salt: z.string().min(1).max(512).regex(BASE64_RE, "salt must be base64"),
    hash: z.string().min(1).max(512).regex(BASE64_RE, "hash must be base64"),
  }),
]);
export type LegacyHash = z.infer<typeof legacyHashSchema>;

/** The string stored in `account.password` for an imported hash. */
export function encodeLegacyHash(hash: LegacyHash): string {
  return hash.algorithm === "bcrypt"
    ? hash.hash
    : `pbkdf2$${hash.digest}$${hash.iterations}$${hash.salt}$${hash.hash}`;
}

const isBcrypt = (stored: string) => BCRYPT_RE.test(stored);
const isPbkdf2 = (stored: string) => stored.startsWith("pbkdf2$");

async function verifyPbkdf2(stored: string, password: string) {
  const [, digest, iterations, salt, hash] = stored.split("$");
  const parsed = legacyHashSchema.safeParse({
    algorithm: "pbkdf2",
    digest,
    iterations: Number(iterations),
    salt,
    hash,
  });
  if (!parsed.success || parsed.data.algorithm !== "pbkdf2") return false;
  const expected = Buffer.from(parsed.data.hash, "base64");
  const derived = await pbkdf2Async(
    password,
    Buffer.from(parsed.data.salt, "base64"),
    parsed.data.iterations,
    expected.length,
    parsed.data.digest,
  );
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

/** Replace an imported hash with a native one once the password is known. */
async function upgradeLegacyHash(stored: string, password: string) {
  try {
    await db
      .update(account)
      .set({ password: await hashPassword(password) })
      .where(eq(account.password, stored));
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "[password] could not replace an imported hash; it stays valid",
    );
  }
}

/**
 * Password check used by BetterAuth: native hashes as usual, imported ones by
 * their own algorithm. A successful check on an imported hash re-hashes the
 * password natively, so the legacy algorithm disappears as users sign in.
 */
export async function verifyStoredPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const legacy = isBcrypt(data.hash) || isPbkdf2(data.hash);
  if (!legacy) return verifyPassword(data);

  const ok = isBcrypt(data.hash)
    ? await bcrypt.compare(data.password, data.hash)
    : await verifyPbkdf2(data.hash, data.password);
  if (ok) await upgradeLegacyHash(data.hash, data.password);
  return ok;
}
