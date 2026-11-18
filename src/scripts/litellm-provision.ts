import { loadProvisionEnv, provisionKeys } from "./litellm-provision-lib.js";

function describe(label: string, outcome: string): string {
  if (outcome === "kept") return `✓ gateway ${label} key already in place\n`;
  if (outcome === "reissued") return `✓ gateway ${label} key reissued\n`;
  return `✓ gateway ${label} key issued\n`;
}

/**
 * One-shot: gives auth-service its read-only gateway inventory key and
 * reverse-relay its model management key. Runs after the gateway is up (it
 * needs the master key from the setup state file) and is safe to run at every
 * start.
 */
async function main(): Promise<void> {
  const { inventory, relay } = await provisionKeys(loadProvisionEnv());
  process.stdout.write(describe("inventory", inventory));
  process.stdout.write(describe("relay", relay));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
