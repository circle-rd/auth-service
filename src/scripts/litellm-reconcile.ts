import "dotenv/config";
import { z } from "zod";
import { AuthAdminClient, loadScriptEnv } from "./litellm-lib.js";
import {
  isClean,
  parseSpendLogs,
  reconcile,
  spendLogsPageSchema,
  type GatewayLogEntry,
  type ReconciliationReport,
} from "./litellm-reconcile-lib.js";

const PAGE_SIZE = 100;
// Calls that started shortly before the window can be charged inside it.
const PADDING_MS = 60 * 60 * 1000;
// A debit may sit in the gateway's retry spool for a few minutes after the call.
const SETTLE_MS = 10 * 60 * 1000;

const argsSchema = z.object({
  hours: z.coerce
    .number()
    .positive()
    .max(24 * 31)
    .default(24),
});

const masterKeySchema = z.string().min(1);

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** `YYYY-MM-DD HH:MM:SS` in UTC, the format of the spend-log API. */
const spendLogDate = (d: Date): string =>
  d.toISOString().slice(0, 19).replace("T", " ");

async function fetchGatewayLogs(
  baseUrl: string,
  masterKey: string,
  from: Date,
  to: Date,
): Promise<GatewayLogEntry[]> {
  const logs: GatewayLogEntry[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      start_date: spendLogDate(from),
      end_date: spendLogDate(to),
      page: String(page),
      page_size: String(PAGE_SIZE),
    });
    const res = await fetch(`${baseUrl}/spend/logs/v2?${params}`, {
      headers: { Authorization: `Bearer ${masterKey}` },
    });
    if (!res.ok) {
      throw new Error(
        `Spend logs failed: HTTP ${res.status} ${await res.text()}`,
      );
    }
    const body = spendLogsPageSchema.parse(await res.json());
    logs.push(...parseSpendLogs(body.data));
    if (page >= body.total_pages) return logs;
    page += 1;
  }
}

function print(report: ReconciliationReport): void {
  out(`matched: ${report.matched}`);
  for (const l of report.unbilled) {
    out(
      `UNBILLED   ${l.requestId} user=${l.userId} cost=${l.costUsd} USD at ${l.startedAt.toISOString()}`,
    );
  }
  for (const m of report.mismatched) {
    out(
      `MISMATCH   ${m.log.requestId} gateway=${m.log.costUsd} USD (user ${m.log.userId}) ledger=${m.ledger.costUsd} USD (user ${m.ledger.userId})`,
    );
  }
  for (const o of report.orphaned) {
    out(
      `ORPHAN     ${o.requestId ?? "(no call id)"} user=${o.userId} amount=${o.amount} at ${o.createdAt.toISOString()}`,
    );
  }
  for (const id of report.duplicated) out(`DUPLICATE  ${id}`);
}

async function main(): Promise<void> {
  const { hours } = argsSchema.parse({ hours: process.argv[2] });
  const env = loadScriptEnv();
  const masterKey = masterKeySchema.parse(env.LITELLM_MASTER_KEY);

  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  out(`Reconciling ${from.toISOString()} → ${to.toISOString()}`);

  const admin = new AuthAdminClient(env.authUrl, env.BETTER_AUTH_URL);
  await admin.signIn(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

  try {
    const [logs, ledger] = await Promise.all([
      fetchGatewayLogs(
        env.litellmUrl,
        masterKey,
        new Date(from.getTime() - PADDING_MS),
        to,
      ),
      admin.usageLedger(from, to),
    ]);
    const report = reconcile(logs, ledger, {
      from,
      settledBefore: new Date(to.getTime() - SETTLE_MS),
    });
    print(report);
    if (!isClean(report)) process.exitCode = 1;
    else out("Gateway and wallet agree.");
  } finally {
    await admin.signOut();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
