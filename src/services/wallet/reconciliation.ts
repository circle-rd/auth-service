import { and, asc, eq, gte, like, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { walletAccounts, walletTransactions } from "../../db/schema.js";
import { decodeCursor, encodeCursor } from "./history.js";
import type { GatewayUsageEntry, GatewayUsagePage } from "./types.js";

/** Idempotency-key prefix of the debits reported by the LLM gateway. */
export const GATEWAY_KEY_PREFIX = "litellm:";

export interface ListGatewayUsageInput {
  from: Date;
  to: Date;
  limit: number;
  cursor?: string;
}

/**
 * Usage debits reported by the gateway in `[from, to)`, oldest first, so an
 * operator can compare them with the gateway's own spend logs. Keyset-paginated
 * at microsecond precision like the user history.
 */
export async function listGatewayUsage(
  input: ListGatewayUsageInput,
): Promise<GatewayUsagePage> {
  const after = input.cursor ? decodeCursor(input.cursor) : undefined;

  const rows = await db
    .select({
      id: walletTransactions.id,
      idempotencyKey: walletTransactions.idempotencyKey,
      userId: walletAccounts.ownerId,
      amount: walletTransactions.amount,
      metadata: walletTransactions.metadata,
      createdAt: walletTransactions.createdAt,
      position: sql<string>`to_char(${walletTransactions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(walletTransactions)
    .innerJoin(
      walletAccounts,
      eq(walletAccounts.id, walletTransactions.accountId),
    )
    .where(
      and(
        eq(walletTransactions.type, "usage"),
        eq(walletAccounts.ownerType, "user"),
        like(walletTransactions.idempotencyKey, `${GATEWAY_KEY_PREFIX}%`),
        gte(walletTransactions.createdAt, input.from),
        lt(walletTransactions.createdAt, input.to),
        after
          ? sql`(${walletTransactions.createdAt}, ${walletTransactions.id}) > (${after.t}::timestamptz, ${after.i}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(walletTransactions.createdAt), asc(walletTransactions.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const field = (metadata: unknown, name: string): string | null => {
    const value = (metadata as Record<string, unknown> | null)?.[name];
    return typeof value === "string" ? value : null;
  };
  const items: GatewayUsageEntry[] = page.map((r) => ({
    requestId: field(r.metadata, "requestId"),
    userId: r.userId,
    amount: r.amount.toString(),
    costUsd: field(r.metadata, "costUsd"),
    createdAt: r.createdAt.toISOString(),
  }));
  return {
    items,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ t: last.position, i: last.id })
        : null,
  };
}
