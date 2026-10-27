import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadScriptEnv } from "./litellm-lib.js";
import {
  gatewayConfigSchema,
  importGatewayConfig,
} from "./litellm-config-lib.js";

const masterKeySchema = z.string().min(1);
const IN_PATH = process.argv[2] ?? "litellm-gateway-config.json";

/**
 * One-shot: applies a declarative JSON file of models and access groups. Upserts
 * by name, never deletes, and never touches teams (auth-service owns them) — so
 * it is safe to run after `litellm-provision` on every rebuild.
 */
async function main(): Promise<void> {
  const env = loadScriptEnv();
  const masterKey = masterKeySchema.parse(env.LITELLM_MASTER_KEY);
  const config = gatewayConfigSchema.parse(
    JSON.parse(readFileSync(IN_PATH, "utf8")),
  );
  const report = await importGatewayConfig(
    { base: env.litellmUrl, masterKey },
    config,
  );
  process.stdout.write(
    `✓ models: ${report.modelsCreated.length} created, ${report.modelsUpdated.length} updated; ` +
      `access groups: ${report.groupsCreated.length} created, ${report.groupsUpdated.length} updated\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
