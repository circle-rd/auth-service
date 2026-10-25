import { generateId } from "better-auth";
import type { db } from "../db/index.js";
import { account, user as userTable } from "../db/auth-schema.js";

/** Either the root client or a transaction handle from `db.transaction`. */
export type DbExecutor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CredentialUserInput {
  name: string;
  email: string;
  emailVerified: boolean;
  role?: string;
  /** Explicit id (trusted imports); generated when omitted. */
  id?: string;
  /** Already-hashed password (better-auth scrypt or a legacy encoding). */
  storedPasswordHash: string;
}

/**
 * Insert a `user` row plus its `credential` account in one statement pair.
 *
 * Used by the trusted paths that must write a specific verification state or
 * password hash — BetterAuth's own create flow cannot. Callers run this inside
 * a transaction when the creation must be atomic with another write.
 */
export async function insertCredentialUser(
  exec: DbExecutor,
  input: CredentialUserInput,
): Promise<{ id: string }> {
  const id = input.id ?? generateId();
  const now = new Date();
  await exec.insert(userTable).values({
    id,
    name: input.name,
    email: input.email,
    emailVerified: input.emailVerified,
    role: input.role ?? "user",
    createdAt: now,
    updatedAt: now,
  });
  await exec.insert(account).values({
    id: generateId(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: input.storedPasswordHash,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}
