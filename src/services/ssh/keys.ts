import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sshRecipientKeys } from "../../db/ssh-schema.js";
import { ERR } from "../../errors.js";
import { parseSshPublicKey } from "./crypto.js";

export interface RecipientKeyView {
  id: string;
  publicKey: string;
  fingerprint: string;
  label: string | null;
  createdAt: Date;
}

export async function registerRecipientKey(
  userId: string,
  value: string,
  label?: string | null,
): Promise<RecipientKeyView> {
  const parsed = parseSshPublicKey(value);
  const [existing] = await db
    .select()
    .from(sshRecipientKeys)
    .where(
      and(
        eq(sshRecipientKeys.fingerprint, parsed.fingerprint),
        isNull(sshRecipientKeys.revokedAt),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.userId !== userId) {
      throw ERR.RES_003("This SSH key is already registered");
    }
    return existing;
  }
  const [row] = await db
    .insert(sshRecipientKeys)
    .values({
      userId,
      publicKey: parsed.publicKey,
      fingerprint: parsed.fingerprint,
      label: label?.trim() || null,
    })
    .returning();
  if (!row) throw ERR.RES_001("Could not register the SSH key");
  return row;
}

export async function listRecipientKeys(
  userId: string,
): Promise<RecipientKeyView[]> {
  return db
    .select({
      id: sshRecipientKeys.id,
      publicKey: sshRecipientKeys.publicKey,
      fingerprint: sshRecipientKeys.fingerprint,
      label: sshRecipientKeys.label,
      createdAt: sshRecipientKeys.createdAt,
    })
    .from(sshRecipientKeys)
    .where(
      and(
        eq(sshRecipientKeys.userId, userId),
        isNull(sshRecipientKeys.revokedAt),
      ),
    )
    .orderBy(desc(sshRecipientKeys.createdAt));
}

export async function revokeRecipientKey(
  userId: string,
  id: string,
): Promise<void> {
  const [row] = await db
    .update(sshRecipientKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(sshRecipientKeys.id, id), eq(sshRecipientKeys.userId, userId)),
    )
    .returning({ id: sshRecipientKeys.id });
  if (!row) throw ERR.RES_004();
}

/** Resolve a client key to its active owner without disclosing anything else. */
export async function resolveRecipientKeyUserId(
  value: string,
): Promise<string> {
  const parsed = parseSshPublicKey(value);
  const [row] = await db
    .select({ userId: sshRecipientKeys.userId })
    .from(sshRecipientKeys)
    .where(
      and(
        eq(sshRecipientKeys.fingerprint, parsed.fingerprint),
        isNull(sshRecipientKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!row) throw ERR.RES_004();
  return row.userId;
}
