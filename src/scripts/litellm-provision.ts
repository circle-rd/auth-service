import { loadProvisionEnv, provisionKey } from "./litellm-provision-lib.js";

/**
 * One-shot: gives auth-service the gateway key it uses to keep one team per
 * application with LiteLLM support. Runs after the gateway is up (it needs the
 * master key from the setup state file) and is safe to run at every start.
 */
async function main(): Promise<void> {
  const outcome = await provisionKey(loadProvisionEnv());
  process.stdout.write(
    outcome === "kept"
      ? "✓ gateway provisioning key already in place\n"
      : "✓ gateway provisioning key issued\n",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
