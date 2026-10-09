import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthAdminClient,
  generateSecret,
  loadScriptEnv,
  upsertEnvValue,
} from "./litellm-lib.js";

const GATEWAY_SLUG = "litellm";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Generate the LiteLLM secrets into `.env` without ever overwriting one. */
function ensureSecrets(envPath: string): void {
  const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  let content = original;
  content = upsertEnvValue(
    content,
    "LITELLM_MASTER_KEY",
    generateSecret("sk-"),
  );
  content = upsertEnvValue(content, "LITELLM_SALT_KEY", generateSecret("sk-"));
  if (content === original) {
    out("✓ LITELLM_MASTER_KEY / LITELLM_SALT_KEY already set");
    return;
  }
  writeFileSync(envPath, content, { mode: 0o600 });
  out("✓ Generated missing LITELLM_MASTER_KEY / LITELLM_SALT_KEY in .env");
}

/** `--grant=app-a,app-b`: applications allowed to request LiteLLM tokens. */
function grantedSlugs(): string[] {
  const arg = process.argv.find((a) => a.startsWith("--grant="));
  return arg
    ? arg
        .slice("--grant=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

async function main(): Promise<void> {
  const env = loadScriptEnv();
  // Same file dotenv loaded, so a custom DOTENV_CONFIG_PATH is honoured.
  ensureSecrets(resolve(process.env.DOTENV_CONFIG_PATH ?? ".env"));

  const client = new AuthAdminClient(env.authUrl);
  await client.signIn(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  const apps = await client.listApplications();

  const gateway = apps.find((a) => a.slug === GATEWAY_SLUG);
  if (!gateway) {
    await client.createApplication({
      name: "LiteLLM",
      slug: GATEWAY_SLUG,
      description: "LLM and MCP gateway (protected resource)",
      url: env.LITELLM_PUBLIC_URL,
    });
    out(
      `✓ Registered the "${GATEWAY_SLUG}" application (${env.LITELLM_PUBLIC_URL})`,
    );
  } else if (gateway.url !== env.LITELLM_PUBLIC_URL) {
    await client.updateApplication(gateway.id, { url: env.LITELLM_PUBLIC_URL });
    out(
      `✓ Updated the "${GATEWAY_SLUG}" application URL to ${env.LITELLM_PUBLIC_URL}`,
    );
  } else {
    out(`✓ The "${GATEWAY_SLUG}" application is already registered`);
  }

  for (const slug of grantedSlugs()) {
    const app = apps.find((a) => a.slug === slug);
    if (!app)
      throw new Error(
        `Cannot grant LiteLLM access: unknown application "${slug}"`,
      );
    if (app.allowedResources.includes(env.LITELLM_PUBLIC_URL)) {
      out(`✓ "${slug}" already allowed to request LiteLLM tokens`);
      continue;
    }
    await client.updateApplication(app.id, {
      allowedResources: [...app.allowedResources, env.LITELLM_PUBLIC_URL],
    });
    out(`✓ "${slug}" allowed to request LiteLLM tokens`);
  }

  out("");
  out("Next: docker compose --profile llm up -d, then pnpm llm:smoke");
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
