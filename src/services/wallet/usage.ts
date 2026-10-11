import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { debitWallet } from "./ledger.js";
import type { WalletMetadata, WalletOperationResult } from "./types.js";

export interface RecordUsageInput {
  accountId: string;
  /** Strictly positive, in micro-euros. */
  amount: bigint;
  idempotencyKey: string;
  /** Slug of the application that made the call (the token `azp`). */
  applicationSlug?: string;
  metadata?: WalletMetadata;
}

/**
 * Charge a consumption reported by the LLM gateway. The usage has already
 * happened, so an application that was deleted in the meantime must not make
 * the debit fail: the slug is always kept in the metadata and the ledger link
 * is simply left empty, exactly what `ON DELETE SET NULL` would do later.
 */
export async function recordUsage(
  input: RecordUsageInput,
): Promise<WalletOperationResult> {
  let applicationId: string | undefined;
  if (input.applicationSlug) {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, input.applicationSlug))
      .limit(1);
    applicationId = app?.id;
  }

  return debitWallet({
    accountId: input.accountId,
    type: "usage",
    amount: input.amount,
    idempotencyKey: input.idempotencyKey,
    applicationId,
    metadata: {
      ...input.metadata,
      ...(input.applicationSlug
        ? { applicationSlug: input.applicationSlug }
        : {}),
    },
  });
}
