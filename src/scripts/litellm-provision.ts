import { loadProvisionEnv, provisionKeys } from "./litellm-provision-lib.js";

/**
 * One-shot: gives auth-service a read-only gateway inventory key. Runs after
 * the gateway is up (it needs the master key from the setup state file) and is
 * safe to run at every start.
 */
async function main(): Promise<void> {
  const { inventory } = await provisionKeys(loadProvisionEnv());
  process.stdout.write(
    inventory === "kept"
      ? "✓ gateway inventory key already in place\n"
      : "✓ gateway inventory key issued\n",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
