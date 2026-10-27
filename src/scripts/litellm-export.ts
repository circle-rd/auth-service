import "dotenv/config";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { loadScriptEnv } from "./litellm-lib.js";
import { exportGatewayConfig } from "./litellm-config-lib.js";

const masterKeySchema = z.string().min(1);
const OUT_PATH = process.argv[2] ?? "litellm-gateway-config.json";

/**
 * One-shot: writes the gateway's models and access groups to a JSON file. Teams
 * and provider secrets are never included — a model references its LLM Credential
 * by name, so re-importing after a rebuild only needs the credentials recreated
 * with the same names.
 */
async function main(): Promise<void> {
  const env = loadScriptEnv();
  const masterKey = masterKeySchema.parse(env.LITELLM_MASTER_KEY);
  const config = await exportGatewayConfig({ base: env.litellmUrl, masterKey });
  writeFileSync(OUT_PATH, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(
    `✓ exported ${config.models.length} model(s), ${config.access_groups.length} access group(s) to ${OUT_PATH}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
