import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { walletTransactions } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import type { WalletTransaction, WalletTransactionPage } from "./types.js";
import { toTransactionView } from "./views.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// The cursor carries the timestamp at full microsecond precision: a JS Date
// would truncate to milliseconds and make keyset pagination skip or repeat rows.
const cursorSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.string().uuid(),
});

function encodeCursor(position: { t: string; i: string }): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw ERR.WAL_005();
  }
}

export interface ListTransactionsInput {
  accountId: string;
  limit?: number;
  cursor?: string;
  type?: WalletTransaction["type"];
}

/** Newest first, keyset-paginated so appends never shift later pages. */
export async function listWalletTransactions(
  input: ListTransactionsInput,
): Promise<WalletTransactionPage> {
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const after = input.cursor ? decodeCursor(input.cursor) : undefined;

  const rows = await db
    .select({
      id: walletTransactions.id,
      type: walletTransactions.type,
      amount: walletTransactions.amount,
      delta: walletTransactions.delta,
      balanceAfter: walletTransactions.balanceAfter,
      applicationId: walletTransactions.applicationId,
      metadata: walletTransactions.metadata,
      createdAt: walletTransactions.createdAt,
      position: sql<string>`to_char(${walletTransactions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.accountId, input.accountId),
        input.type ? eq(walletTransactions.type, input.type) : undefined,
        after
          ? sql`(${walletTransactions.createdAt}, ${walletTransactions.id}) < (${after.t}::timestamptz, ${after.i}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(walletTransactions.createdAt), desc(walletTransactions.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toTransactionView),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: last.position, i: last.id })
        : null,
  };
}
