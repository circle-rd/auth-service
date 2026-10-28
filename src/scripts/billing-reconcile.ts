import "dotenv/config";
import { isStripeConfigured } from "../services/stripe.js";
import {
  reconcileBilling,
  type ReconciliationReport,
} from "../services/billing/reconciliation.js";

/**
 * Operator reconciliation between the billing rows and Stripe.
 *
 *   pnpm billing:reconcile                     create missing objects, report drift
 *   pnpm billing:reconcile --check             read-only audit, exit 1 on drift
 *   pnpm billing:reconcile --cancel-superseded  also cancel subscriptions a newer one replaced
 *   pnpm billing:reconcile --json               machine-readable report
 *
 * `repair` is the default so the historical behaviour (fill what an outage
 * missed) is unchanged. A drift that cannot be repaired safely is reported and
 * leaves the process with exit code 1; nothing is ever deleted from Stripe.
 */

const KNOWN_FLAGS = new Set([
  "--check",
  "--cancel-superseded",
  "--recreate-missing",
  "--json",
  "--help",
]);

const USAGE = `Usage: pnpm billing:reconcile [options]

  --check              Read-only audit; exit 1 when drift or pending meter events exist.
  --cancel-superseded  Repair mode: also cancel active subscriptions a newer one replaced.
  --recreate-missing   Repair mode: recreate a subscription Stripe confirms as deleted.
  --json               Print the report as JSON.
  --help               Show this help.
`;

function parseArgs(argv: string[]): {
  mode: "check" | "repair";
  cancelSuperseded: boolean;
  recreateMissing: boolean;
  json: boolean;
} {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}`,
    );
  }
  const check = argv.includes("--check");
  return {
    mode: check ? "check" : "repair",
    cancelSuperseded: !check && argv.includes("--cancel-superseded"),
    recreateMissing: !check && argv.includes("--recreate-missing"),
    json: argv.includes("--json"),
  };
}

function printHuman(report: ReconciliationReport): void {
  for (const issue of report.issues) {
    process.stdout.write(
      `${issue.action.toUpperCase().padEnd(8)} ${issue.kind.padEnd(24)} ${issue.detail}\n`,
    );
  }
  const s = report.summary;
  process.stdout.write(
    `${report.mode === "check" ? "checked" : "reconciled"}: ` +
      `${s.customersCreated} customer(s), ${s.productsCreated} product(s), ` +
      `${s.pricesCreated} price(s) created, ${s.subscriptionsLinked} subscription(s) linked, ` +
      `${s.statesSynced} state(s) synced, ${s.supersededCancelled} superseded subscription(s) cancelled\n`,
  );
  process.stdout.write(
    `meter events: ${report.pendingMeterEvents} pending, ${report.pushedMeterEvents} pushed\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (!isStripeConfigured()) {
    process.stdout.write("Stripe is not configured; nothing to reconcile.\n");
    return;
  }

  const report = await reconcileBilling({
    mode: options.mode,
    cancelSuperseded: options.cancelSuperseded,
    recreateMissing: options.recreateMissing,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }

  const remaining = report.issues.filter(
    (issue) => issue.action === "reported",
  );
  if (
    options.mode === "check" &&
    (report.issues.length > 0 || report.pendingMeterEvents > 0)
  ) {
    process.exitCode = 1;
  } else if (options.mode === "repair" && remaining.length > 0) {
    process.stdout.write(
      `${remaining.length} drift item(s) need an operator decision\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
