import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthAdminClient,
  WALLET_CLIENT_SLUG,
  WALLET_SCOPES,
  generateSecret,
  loadScriptEnv,
  replaceEnvValue,
  upsertEnvValue,
  type AdminApplication,
  type ScriptEnv,
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

function storeWalletSecret(envPath: string, secret: string): void {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(
    envPath,
    replaceEnvValue(content, "LITELLM_WALLET_CLIENT_SECRET", secret),
    { mode: 0o600 },
  );
}

function currentWalletSecret(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const match = /^LITELLM_WALLET_CLIENT_SECRET=(.*)$/m.exec(
    readFileSync(envPath, "utf8"),
  );
  return match?.[1]?.trim() || undefined;
}

function sameScopes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((scope) => b.includes(scope));
}

/**
 * Register the machine application the gateway uses to call the wallet API and
 * make sure the secret kept in `.env` still works (a recreated database leaves
 * a stale one behind): a missing or rejected secret is rotated.
 */
async function ensureWalletClient(
  client: AuthAdminClient,
  apps: AdminApplication[],
  env: ScriptEnv,
  envPath: string,
): Promise<void> {
  let wallet = apps.find((a) => a.slug === WALLET_CLIENT_SLUG);
  if (!wallet) {
    const created = await client.createApplication({
      name: "LiteLLM wallet",
      slug: WALLET_CLIENT_SLUG,
      description: "LLM gateway machine client for the wallet API",
    });
    if (!created.clientSecret) {
      throw new Error("Wallet client was created without a secret");
    }
    wallet = created.application;
    storeWalletSecret(envPath, created.clientSecret);
    out(
      `✓ Registered the "${WALLET_CLIENT_SLUG}" application and stored its secret in .env`,
    );
  }

  if (!sameScopes(await client.getMachineScopes(wallet.id), WALLET_SCOPES)) {
    await client.setMachineScopes(wallet.id, WALLET_SCOPES);
    out(`✓ "${WALLET_CLIENT_SLUG}" granted ${WALLET_SCOPES.join(", ")}`);
  }

  // The file wins: it holds the secret written above, whereas the process
  // environment may still carry a stale value from before a database reset.
  const secret =
    currentWalletSecret(envPath) ?? env.LITELLM_WALLET_CLIENT_SECRET;
  const works =
    secret !== undefined &&
    (await client.canObtainToken({
      clientId: WALLET_CLIENT_SLUG,
      clientSecret: secret,
      scope: WALLET_SCOPES.join(" "),
    }));
  if (works) {
    out(`✓ "${WALLET_CLIENT_SLUG}" credentials in .env are valid`);
    return;
  }
  storeWalletSecret(envPath, await client.rotateSecret(wallet.id));
  out(`✓ Rotated the "${WALLET_CLIENT_SLUG}" secret and stored it in .env`);
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
  const envPath = resolve(process.env.DOTENV_CONFIG_PATH ?? ".env");
  ensureSecrets(envPath);

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

  await ensureWalletClient(client, apps, env, envPath);

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
