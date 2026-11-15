import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Gateway user that owns the inventory key. It is a read-only administrator:
 * auth-service mirrors models, agents and MCP servers, never writes to them.
 */
export const INVENTORY_USER_ID = "auth-service-inventory";
export const INVENTORY_KEY_ALIAS = "auth-service-inventory";

/** Path-only allowlist (LiteLLM does not filter allowed_routes by method). */
export const INVENTORY_ROUTES = [
  "/v1/models",
  "/v1/agents",
  "/v1/mcp/server",
] as const;

const provisionEnvSchema = z.object({
  LITELLM_URL: z.string().url(),
  LITELLM_INVENTORY_KEY_FILE: z.string().min(1),
  LITELLM_STATE_FILE: z.string().min(1),
});

export interface ProvisionEnv {
  gatewayUrl: string;
  inventoryKeyFile: string;
  stateFile: string;
}

export function loadProvisionEnv(
  source: NodeJS.ProcessEnv = process.env,
): ProvisionEnv {
  const parsed = provisionEnvSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${fields}`);
  }
  const keyFile = parsed.data.LITELLM_INVENTORY_KEY_FILE;
  return {
    gatewayUrl: parsed.data.LITELLM_URL.replace(/\/+$/, ""),
    inventoryKeyFile: keyFile,
    stateFile: parsed.data.LITELLM_STATE_FILE,
  };
}

const keyResponseSchema = z.object({ key: z.string().min(1) });

async function gatewayCall(
  env: ProvisionEnv,
  bearer: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${env.gatewayUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, text: await res.text() };
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export type ProvisionOutcome = "kept" | "created";

interface Probe {
  method: "GET" | "POST";
  path: string;
  status: number;
  body?: unknown;
}

const INVENTORY_PROBES: readonly Probe[] = [
  { method: "GET", path: "/v1/models", status: 200 },
  { method: "GET", path: "/v1/agents", status: 200 },
  { method: "GET", path: "/v1/mcp/server", status: 200 },
  {
    method: "POST",
    path: "/v1/mcp/server",
    status: 403,
    body: { server_name: "probe", url: "http://127.0.0.1" },
  },
  {
    method: "POST",
    path: "/team/new",
    status: 403,
    body: { team_alias: "probe" },
  },
  { method: "POST", path: "/key/generate", status: 403, body: {} },
];

async function scopeMatches(env: ProvisionEnv, key: string): Promise<boolean> {
  for (const probe of INVENTORY_PROBES) {
    const answer = await gatewayCall(
      env,
      key,
      probe.method,
      probe.path,
      probe.body,
    );
    if (answer.status !== probe.status) return false;
  }
  return true;
}

function masterKeyOf(env: ProvisionEnv): string {
  const stateFile = readFileOrNull(env.stateFile);
  const masterKey = stateFile
    ? /^LITELLM_MASTER_KEY=(.+)$/m.exec(stateFile)?.[1]?.trim()
    : undefined;
  if (!masterKey) {
    throw new Error(
      `LITELLM_MASTER_KEY not found in ${env.stateFile} (has litellm-setup run?)`,
    );
  }
  return masterKey;
}

async function ensureInventoryViewer(
  env: ProvisionEnv,
  masterKey: string,
): Promise<void> {
  // A read-only proxy administrator can read the full inventory but cannot
  // mutate it, even though allowed_routes only matches paths.
  const user = await gatewayCall(env, masterKey, "POST", "/user/new", {
    user_id: INVENTORY_USER_ID,
    user_role: "proxy_admin_viewer",
    auto_create_key: false,
  });
  if (
    user.status >= 300 &&
    !/already exists|duplicate|unique/i.test(user.text)
  ) {
    throw new Error(`user creation failed: HTTP ${user.status} ${user.text}`);
  }
}

async function issueKey(env: ProvisionEnv, masterKey: string): Promise<string> {
  await ensureInventoryViewer(env, masterKey);

  // Revoke what an earlier run left (an unusable file, or a lost one).
  await gatewayCall(env, masterKey, "POST", "/key/delete", {
    key_aliases: [INVENTORY_KEY_ALIAS],
  });

  const issued = await gatewayCall(env, masterKey, "POST", "/key/generate", {
    user_id: INVENTORY_USER_ID,
    key_alias: INVENTORY_KEY_ALIAS,
    allowed_routes: INVENTORY_ROUTES,
  });
  if (issued.status >= 300) {
    throw new Error(
      `key creation failed: HTTP ${issued.status} ${issued.text}`,
    );
  }
  return keyResponseSchema.parse(JSON.parse(issued.text)).key;
}

/**
 * Make sure the inventory key file holds a working, read-only gateway key. A key
 * that still works is kept; otherwise the previous alias is revoked and a new
 * key is issued. Idempotent.
 */
export async function provisionInventoryKey(
  env: ProvisionEnv,
): Promise<ProvisionOutcome> {
  const existing = readFileOrNull(env.inventoryKeyFile)?.trim();
  if (existing && (await scopeMatches(env, existing))) return "kept";

  const masterKey = masterKeyOf(env);
  const key = await issueKey(env, masterKey);
  if (!(await scopeMatches(env, key))) {
    // Fail closed: a key wider than its requested allowlist must not be kept.
    await gatewayCall(env, masterKey, "POST", "/key/delete", {
      key_aliases: [INVENTORY_KEY_ALIAS],
    });
    throw new Error(
      `key '${INVENTORY_KEY_ALIAS}' does not enforce its read-only inventory scope`,
    );
  }

  mkdirSync(dirname(env.inventoryKeyFile), { recursive: true });
  writeFileSync(env.inventoryKeyFile, `${key}\n`, { mode: 0o644 });
  return "created";
}

export async function provisionKeys(
  env: ProvisionEnv,
): Promise<{ inventory: ProvisionOutcome }> {
  return { inventory: await provisionInventoryKey(env) };
}
