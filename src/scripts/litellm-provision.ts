import { loadProvisionEnv, provisionKeys } from "./litellm-provision-lib.js";

/**
 * One-shot: gives auth-service the two gateway keys it uses — one for plan
 * teams, one restricted to shared-resource access groups. Runs after the
 * gateway is up (it needs the master key from the setup state file) and is safe
 * to run at every start.
 */
async function main(): Promise<void> {
  const { team, resourceSync } = await provisionKeys(loadProvisionEnv());
  const line = (label: string, outcome: string): string =>
    outcome === "kept"
      ? `✓ gateway ${label} key already in place\n`
      : `✓ gateway ${label} key issued\n`;
  process.stdout.write(
    line("team", team) + line("resource-sync", resourceSync),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
