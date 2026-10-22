import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDatabase } from "./litellm-database.js";
import {
  AuthAdminClient,
  WALLET_CLIENT_SLUG,
  WALLET_SCOPES,
  generateSecret,
  loadScriptEnv,
  readEnvValue,
  removeEnvValue,
  replaceEnvValue,
  resolveSecret,
  shellQuote,
  ssoGatewayEnv,
  type AdminApplication,
  type ScriptEnv,
  TwoFactorRequiredError,
  isSetupComplete,
} from "./litellm-lib.js";
import {
  LITELLM_GATEWAY_SLUG as GATEWAY_SLUG,
  LITELLM_UI_SLUG as UI_SLUG,
} from "../services/system-apps.js";

// Sign-in to the LiteLLM admin interface through auth-service (generic OIDC).
const UI_SCOPES = ["openid", "profile", "email", "roles"];

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Settle the gateway's master and salt keys in the state file: values supplied
 * through the environment win, stored ones are kept, and only a missing one is
 * generated.
 */
function ensureSecrets(statePath: string): void {
  const original = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
  let content = original;
  for (const key of ["LITELLM_MASTER_KEY", "LITELLM_SALT_KEY"] as const) {
    const result = resolveSecret(content, key, process.env[key], () =>
      generateSecret("sk-"),
    );
    content = result.content;
    if (result.action === "replaced" && key === "LITELLM_SALT_KEY") {
      out(
        "! LITELLM_SALT_KEY changed: provider credentials stored by LiteLLM can no longer be read",
      );
    }
    if (result.action === "generated") out(`✓ Generated ${key}`);
    if (result.action === "supplied") out(`✓ Stored the ${key} you supplied`);
    if (result.action === "replaced")
      out(`✓ Updated ${key} from the environment`);
  }
  if (content === original) {
    out("✓ LITELLM_MASTER_KEY / LITELLM_SALT_KEY already set");
    return;
  }
  writeFileSync(statePath, content, { mode: 0o600 });
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
  return readEnvValue(
    readFileSync(envPath, "utf8"),
    "LITELLM_WALLET_CLIENT_SECRET",
  );
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
      isSystem: true,
    });
    if (!created.clientSecret) {
      throw new Error("Wallet client was created without a secret");
    }
    wallet = created.application;
    storeWalletSecret(envPath, created.clientSecret);
    out(
      `✓ Registered the "${WALLET_CLIENT_SLUG}" application and stored its secret`,
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
    out(`✓ "${WALLET_CLIENT_SLUG}" credentials are valid`);
    return;
  }
  storeWalletSecret(envPath, await client.rotateSecret(wallet.id));
  out(`✓ Rotated the "${WALLET_CLIENT_SLUG}" secret and stored it`);
}

/** The applications this script provisions are infrastructure: hidden and undeletable. */
async function ensureSystemFlag(
  client: AuthAdminClient,
  app: AdminApplication,
): Promise<void> {
  if (app.isSystem) return;
  await client.updateApplication(app.id, { isSystem: true });
  out(`✓ Marked "${app.slug}" as a system application`);
}

function setStateValues(
  statePath: string,
  change: (content: string) => string,
): void {
  const content = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
  writeFileSync(statePath, change(content), { mode: 0o600 });
}

/**
 * Let administrators sign in to the LiteLLM interface with their auth-service
 * account. The gateway reads the whole `GENERIC_*` configuration (see
 * `ssoGatewayEnv`) from the state file: writing it turns the sign-in on, removing
 * it turns it off.
 * The application is private, so only users granted access in auth-service can
 * sign in: the `admin` role of the application makes a LiteLLM administrator,
 * the `user` role a read-only viewer. Creating the application gives its creator
 * (the administrator running the setup) the `admin` role.
 */
async function ensureUiSso(
  client: AuthAdminClient,
  apps: AdminApplication[],
  env: ScriptEnv,
  statePath: string,
  adminUserId: string,
): Promise<void> {
  const sso = ssoGatewayEnv({
    gatewayPublicUrl: env.LITELLM_PUBLIC_URL,
    authPublicUrl: env.BETTER_AUTH_URL,
    authInternalUrl: env.authUrl,
  });
  if (env.LITELLM_SSO_ENABLED === "false") {
    setStateValues(statePath, (c) =>
      [
        "GENERIC_CLIENT_ID",
        "GENERIC_CLIENT_SECRET",
        ...Object.keys(sso),
      ].reduce(removeEnvValue, c),
    );
    out("✓ Admin interface sign-in through auth-service is turned off");
    return;
  }

  const callback = `${env.LITELLM_PUBLIC_URL.replace(/\/$/, "")}/sso/callback`;
  let ui = apps.find((a) => a.slug === UI_SLUG);
  let issuedSecret: string | undefined;
  if (!ui) {
    const created = await client.createApplication({
      name: "LiteLLM admin interface",
      slug: UI_SLUG,
      description: "Sign-in to the LiteLLM admin interface",
      isPublic: false,
      isSystem: true,
      allowRegister: false,
      skipConsent: true,
      allowedScopes: UI_SCOPES,
      redirectUris: [callback],
    });
    ui = created.application;
    issuedSecret = created.clientSecret;
    if (!issuedSecret)
      throw new Error("Admin UI client was created without a secret");
    out(`✓ Registered the "${UI_SLUG}" application (${callback})`);
  } else if (
    !ui.redirectUris.includes(callback) ||
    !UI_SCOPES.every((scope) => ui!.allowedScopes.includes(scope))
  ) {
    await client.updateApplication(ui.id, {
      redirectUris: [...new Set([...ui.redirectUris, callback])],
      allowedScopes: [...new Set([...ui.allowedScopes, ...UI_SCOPES])],
    });
    out(`✓ Updated the "${UI_SLUG}" redirect URI and scopes`);
  }

  // The creator holds the `admin` role from the start; this only repairs an
  // account left without any role. A role chosen since (a demotion to `user`) stays.
  const adminRole = (await client.listRoles(ui.id)).find(
    (r) => r.name === "admin",
  );
  const member = (await client.listApplicationUsers(ui.id)).find(
    (u) => u.userId === adminUserId,
  );
  if (adminRole && !member?.roleId) {
    await client.grantAccess(ui.id, {
      userId: adminUserId,
      roleId: adminRole.id,
    });
    out(`✓ Gave ${env.ADMIN_EMAIL} the admin role on "${UI_SLUG}"`);
  }

  const content = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
  let secret = issuedSecret ?? readEnvValue(content, "GENERIC_CLIENT_SECRET");
  if (!secret) {
    secret = await client.rotateSecret(ui.id);
    out(`✓ Issued a new secret for "${UI_SLUG}"`);
  }
  setStateValues(statePath, (c) =>
    Object.entries({
      ...Object.fromEntries(
        Object.entries(sso).map(([key, value]) => [key, shellQuote(value)]),
      ),
      GENERIC_CLIENT_ID: UI_SLUG,
      GENERIC_CLIENT_SECRET: secret,
    }).reduce((acc, [key, value]) => replaceEnvValue(acc, key, value), c),
  );
  out("✓ Admin interface sign-in through auth-service is on");
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
  // In a container the secrets live in a file of the volume shared with the
  // gateway; from a checkout they go to `.env`, the file dotenv loaded.
  const envPath = resolve(
    process.env.LITELLM_STATE_FILE ?? process.env.DOTENV_CONFIG_PATH ?? ".env",
  );
  ensureSecrets(envPath);

  // Set by the compose file only: a checkout has its own database setup.
  if (env.LITELLM_DB_ADMIN_URL) {
    const outcome = await ensureDatabase(env.LITELLM_DB_ADMIN_URL, "litellm");
    out(
      outcome === "created"
        ? '✓ Created the "litellm" database'
        : '✓ "litellm" database already exists',
    );
  }

  const client = new AuthAdminClient(env.authUrl, env.BETTER_AUTH_URL);
  let adminUserId: string;
  try {
    adminUserId = await client.signIn(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  } catch (err) {
    // MFA enabled after a successful setup must not keep the gateway down:
    // what the setup provisions is already stored, so it only has nothing to add.
    const ssoEnabled =
      Boolean(process.env.LITELLM_STATE_FILE) &&
      env.LITELLM_SSO_ENABLED !== "false";
    const state = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (
      err instanceof TwoFactorRequiredError &&
      isSetupComplete(state, ssoEnabled)
    ) {
      out(`! ${err.message}`);
      out(
        "✓ Setup already completed by a previous run: nothing to provision, skipping (changes to LITELLM_PUBLIC_URL or --grant need an administrator without MFA)",
      );
      return;
    }
    throw err;
  }
  try {
    const apps = await client.listApplications();
    for (const slug of [GATEWAY_SLUG, WALLET_CLIENT_SLUG, UI_SLUG]) {
      const existing = apps.find((a) => a.slug === slug);
      if (existing) await ensureSystemFlag(client, existing);
    }

    const gateway = apps.find((a) => a.slug === GATEWAY_SLUG);
    if (!gateway) {
      await client.createApplication({
        name: "LiteLLM",
        slug: GATEWAY_SLUG,
        description: "LLM and MCP gateway (protected resource)",
        url: env.LITELLM_PUBLIC_URL,
        isSystem: true,
      });
      out(
        `✓ Registered the "${GATEWAY_SLUG}" application (${env.LITELLM_PUBLIC_URL})`,
      );
    } else if (gateway.url !== env.LITELLM_PUBLIC_URL) {
      await client.updateApplication(gateway.id, {
        url: env.LITELLM_PUBLIC_URL,
      });
      out(
        `✓ Updated the "${GATEWAY_SLUG}" application URL to ${env.LITELLM_PUBLIC_URL}`,
      );
    } else {
      out(`✓ The "${GATEWAY_SLUG}" application is already registered`);
    }

    await ensureWalletClient(client, apps, env, envPath);
    // Only in a container, where the secrets live in a file the gateway reads.
    if (process.env.LITELLM_STATE_FILE) {
      await ensureUiSso(client, apps, env, envPath, adminUserId);
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

    if (!process.env.LITELLM_STATE_FILE) {
      out("");
      out("Next: docker compose --profile llm up -d, then pnpm llm:smoke");
    }
  } finally {
    await client.signOut();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
