import { z } from "zod";

/** One billable call, as the gateway recorded it in its spend logs. */
export interface GatewayLogEntry {
  requestId: string;
  userId: string;
  costUsd: number;
  startedAt: Date;
}

/** One usage debit, as the wallet recorded it. */
export interface LedgerEntry {
  requestId: string | null;
  userId: string;
  amount: string;
  costUsd: string | null;
  createdAt: Date;
}

export interface ReconciliationReport {
  matched: number;
  /** Billable gateway calls the wallet never charged. */
  unbilled: GatewayLogEntry[];
  /** Same call, different provider cost on each side. */
  mismatched: { log: GatewayLogEntry; ledger: LedgerEntry }[];
  /** Charges with no gateway call behind them, or that cannot be tied to one. */
  orphaned: LedgerEntry[];
  /** Call ids charged more than once. */
  duplicated: string[];
}

const spendLogSchema = z.object({
  call_type: z.string().nullable().optional(),
  spend: z.number().nullable().optional(),
  user: z.string().nullable().optional(),
  startTime: z.string(),
  metadata: z
    .object({ litellm_call_id: z.string().nullable().optional() })
    .passthrough()
    .nullable()
    .optional(),
});

export const spendLogsPageSchema = z.object({
  data: z.array(z.unknown()),
  total_pages: z.number().int(),
});

/**
 * Billable calls found in raw spend-log rows. Rows without a user (master key,
 * admin interface) are service traffic and rows that cost nothing owe nothing.
 * Malformed rows are rejected rather than skipped: a silent gap would look like
 * a clean reconciliation.
 */
export function parseSpendLogs(rows: unknown[]): GatewayLogEntry[] {
  const entries: GatewayLogEntry[] = [];
  for (const raw of rows) {
    const row = spendLogSchema.parse(raw);
    const requestId = row.metadata?.litellm_call_id;
    if (!row.user || !row.spend || row.spend <= 0) continue;
    if (!requestId) {
      throw new Error(`Spend log of user ${row.user} has no litellm_call_id`);
    }
    entries.push({
      requestId,
      userId: row.user,
      costUsd: row.spend,
      startedAt: new Date(row.startTime),
    });
  }
  return entries;
}

function sameCost(ledger: string | null, log: number): boolean {
  if (ledger === null) return false;
  const a = Number(ledger);
  return Math.abs(a - log) <= Math.max(1e-9, Math.abs(log) * 1e-6);
}

export interface ReconcileWindow {
  /** Calls started before this are not expected in the ledger window. */
  from: Date;
  /**
   * Anything more recent is still in flight: a debit may sit in the gateway's
   * retry spool, and the gateway writes its spend logs in delayed batches.
   */
  settledBefore: Date;
}

/** Compare the gateway's billable calls with the wallet's usage debits. */
export function reconcile(
  logs: GatewayLogEntry[],
  ledger: LedgerEntry[],
  window: ReconcileWindow,
): ReconciliationReport {
  const byRequest = new Map<string, LedgerEntry[]>();
  const orphaned: LedgerEntry[] = [];
  const isSettled = (entry: LedgerEntry): boolean =>
    entry.createdAt < window.settledBefore;
  for (const entry of ledger) {
    if (entry.requestId === null) {
      if (isSettled(entry)) orphaned.push(entry);
      continue;
    }
    byRequest.set(entry.requestId, [
      ...(byRequest.get(entry.requestId) ?? []),
      entry,
    ]);
  }

  const logIds = new Set(logs.map((l) => l.requestId));
  const report: ReconciliationReport = {
    matched: 0,
    unbilled: [],
    mismatched: [],
    orphaned,
    duplicated: [],
  };

  for (const [requestId, entries] of byRequest) {
    if (!logIds.has(requestId)) {
      report.orphaned.push(...entries.filter(isSettled));
    }
    if (entries.length > 1) report.duplicated.push(requestId);
  }

  for (const log of logs) {
    const entries = byRequest.get(log.requestId);
    const entry = entries?.[0];
    if (!entry) {
      const inWindow =
        log.startedAt >= window.from && log.startedAt < window.settledBefore;
      if (inWindow) report.unbilled.push(log);
      continue;
    }
    if (entry.userId !== log.userId || !sameCost(entry.costUsd, log.costUsd)) {
      report.mismatched.push({ log, ledger: entry });
    } else {
      report.matched += 1;
    }
  }
  return report;
}

export function isClean(report: ReconciliationReport): boolean {
  return (
    report.unbilled.length === 0 &&
    report.mismatched.length === 0 &&
    report.orphaned.length === 0 &&
    report.duplicated.length === 0
  );
}
