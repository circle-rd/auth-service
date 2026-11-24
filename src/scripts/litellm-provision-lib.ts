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
  "/model/info",
  "/v1/agents",
  "/v1/mcp/server",
] as const;

/**
 * Gateway user that owns the key reverse-relay uses to manage its own
 * deployments. The /model/* management endpoints require proxy_admin.
 */
export const RELAY_USER_ID = "auth-service-relay";
export const RELAY_KEY_ALIAS = "auth-service-relay";

/** Path-only allowlist, kept narrow because LiteLLM ignores the method. */
export const RELAY_ROUTES = [
  "/model/info",
  "/model/new",
  "/model/delete",
] as const;

const provisionEnvSchema = z.object({
  LITELLM_URL: z.string().url(),
  LITELLM_INVENTORY_KEY_FILE: z.string().min(1),
  LITELLM_RELAY_KEY_FILE: z
    .string()
    .min(1)
    .default("/run/litellm-provisioner/relay-key"),
  LITELLM_STATE_FILE: z.string().min(1),
});

export interface ProvisionEnv {
  gatewayUrl: string;
  inventoryKeyFile: string;
  relayKeyFile: string;
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
  return {
    gatewayUrl: parsed.data.LITELLM_URL.replace(/\/+$/, ""),
    inventoryKeyFile: parsed.data.LITELLM_INVENTORY_KEY_FILE,
    relayKeyFile: parsed.data.LITELLM_RELAY_KEY_FILE,
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

export type ProvisionOutcome = "kept" | "created" | "reissued";

interface Probe {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  expect: number;
}

interface KeySpec {
  label: string;
  userId: string;
  alias: string;
  role: string;
  routes: readonly string[];
  verifyScope: (env: ProvisionEnv, key: string) => Promise<boolean>;
  scopeFailure: string;
}

const INVENTORY_PROBES: readonly Probe[] = [
  { method: "GET", path: "/v1/models", expect: 200 },
  { method: "GET", path: "/model/info", expect: 200 },
  { method: "GET", path: "/v1/agents", expect: 200 },
  { method: "GET", path: "/v1/mcp/server", expect: 200 },
  {
    method: "POST",
    path: "/v1/mcp/server",
    expect: 403,
    body: { server_name: "probe", url: "http://127.0.0.1" },
  },
  {
    method: "POST",
    path: "/team/new",
    expect: 403,
    body: { team_alias: "probe" },
  },
  { method: "POST", path: "/key/generate", expect: 403, body: {} },
];

const INVENTORY_SPEC: KeySpec = {
  label: "inventory",
  userId: INVENTORY_USER_ID,
  alias: INVENTORY_KEY_ALIAS,
  role: "proxy_admin_viewer",
  routes: INVENTORY_ROUTES,
  verifyScope: (env, key) => scopeMatches(env, key, INVENTORY_PROBES),
  scopeFailure: "does not enforce its read-only inventory scope",
};

// Reserved probe name: the model management check owns and removes these rows.
const RELAY_PROBE_MODEL = "relay-key-probe";
const RELAY_PROBE_DEPLOYMENT = {
  model_name: RELAY_PROBE_MODEL,
  litellm_params: {
    model: "openai/gpt-4o",
    api_key: "relay-probe-placeholder",
  },
};

const RELAY_NEGATIVE_PROBES: readonly Probe[] = [
  { method: "POST", path: "/key/generate", expect: 403, body: {} },
  {
    method: "POST",
    path: "/team/new",
    expect: 403,
    body: { team_alias: "probe" },
  },
  { method: "GET", path: "/key/info", expect: 403 },
];

const RELAY_SPEC: KeySpec = {
  label: "relay",
  userId: RELAY_USER_ID,
  alias: RELAY_KEY_ALIAS,
  role: "proxy_admin",
  routes: RELAY_ROUTES,
  verifyScope: relayScopeMatches,
  scopeFailure: "does not enforce its relay management scope",
};

const modelInfoSchema = z
  .object({
    data: z.array(
      z
        .object({
          model_name: z.string(),
          model_info: z.object({ id: z.string().min(1) }).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface ModelInfoEntry {
  model_name: string;
  model_info?: { id: string };
}

function parseModelInfo(text: string): ModelInfoEntry[] | null {
  try {
    const parsed = modelInfoSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.data : null;
  } catch {
    return null;
  }
}

async function listModels(
  env: ProvisionEnv,
  key: string,
): Promise<ModelInfoEntry[] | null> {
  const answer = await gatewayCall(env, key, "GET", "/model/info");
  if (answer.status !== 200) return null;
  return parseModelInfo(answer.text);
}

function probeDeployments(entries: readonly ModelInfoEntry[]): string[] | null {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.model_name !== RELAY_PROBE_MODEL) continue;
    const id = entry.model_info?.id;
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * LiteLLM answers 500 on POST /model/new when litellm_params is incomplete, so
 * a status-only probe cannot tell a broken handler from a missing route. The
 * relay check therefore creates a throwaway deployment and removes it by id,
 * including any copy a failed earlier run left behind.
 */
async function cleanupProbeDeployments(
  env: ProvisionEnv,
  key: string,
): Promise<boolean> {
  const entries = await listModels(env, key);
  if (!entries) return false;
  const ids = probeDeployments(entries);
  if (!ids) return false;
  if (ids.length === 0) return true;

  for (const id of ids) {
    const deleted = await gatewayCall(env, key, "POST", "/model/delete", {
      id,
    });
    if (deleted.status !== 200 && deleted.status !== 404) return false;
  }

  const remaining = await listModels(env, key);
  if (!remaining) return false;
  return probeDeployments(remaining)?.length === 0;
}

async function relayScopeMatches(
  env: ProvisionEnv,
  key: string,
): Promise<boolean> {
  if (!(await cleanupProbeDeployments(env, key))) return false;

  const created = await gatewayCall(
    env,
    key,
    "POST",
    "/model/new",
    RELAY_PROBE_DEPLOYMENT,
  );
  if (created.status !== 200) {
    await cleanupProbeDeployments(env, key);
    return false;
  }
  if (!(await cleanupProbeDeployments(env, key))) return false;

  return scopeMatches(env, key, RELAY_NEGATIVE_PROBES);
}

async function scopeMatches(
  env: ProvisionEnv,
  key: string,
  probes: readonly Probe[],
): Promise<boolean> {
  for (const probe of probes) {
    const answer = await gatewayCall(
      env,
      key,
      probe.method,
      probe.path,
      probe.body,
    );
    if (answer.status !== probe.expect) return false;
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

async function ensureUser(
  env: ProvisionEnv,
  masterKey: string,
  spec: KeySpec,
): Promise<void> {
  const user = await gatewayCall(env, masterKey, "POST", "/user/new", {
    user_id: spec.userId,
    user_role: spec.role,
    auto_create_key: false,
  });
  if (
    user.status >= 300 &&
    !/already exists|duplicate|unique/i.test(user.text)
  ) {
    throw new Error(
      `${spec.label} user creation failed: HTTP ${user.status} ${user.text}`,
    );
  }
}

async function issueKey(
  env: ProvisionEnv,
  masterKey: string,
  spec: KeySpec,
): Promise<string> {
  await ensureUser(env, masterKey, spec);

  // Revoke what an earlier run left (an unusable file, or a lost one).
  await gatewayCall(env, masterKey, "POST", "/key/delete", {
    key_aliases: [spec.alias],
  });

  const issued = await gatewayCall(env, masterKey, "POST", "/key/generate", {
    user_id: spec.userId,
    key_alias: spec.alias,
    allowed_routes: spec.routes,
  });
  if (issued.status >= 300) {
    throw new Error(
      `${spec.label} key creation failed: HTTP ${issued.status} ${issued.text}`,
    );
  }
  return keyResponseSchema.parse(JSON.parse(issued.text)).key;
}

async function provisionKey(
  env: ProvisionEnv,
  spec: KeySpec,
  keyFile: string,
): Promise<ProvisionOutcome> {
  const existing = readFileOrNull(keyFile)?.trim();
  if (existing && (await spec.verifyScope(env, existing))) {
    return "kept";
  }

  const masterKey = masterKeyOf(env);
  const key = await issueKey(env, masterKey, spec);
  if (!(await spec.verifyScope(env, key))) {
    // Fail closed: a key wider than its requested allowlist must not be kept.
    await gatewayCall(env, masterKey, "POST", "/key/delete", {
      key_aliases: [spec.alias],
    });
    throw new Error(`key '${spec.alias}' ${spec.scopeFailure}`);
  }

  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${key}\n`, { mode: 0o644 });
  return existing ? "reissued" : "created";
}

/**
 * Make sure the inventory key file holds a working, read-only gateway key. A key
 * that still works is kept; otherwise the previous alias is revoked and a new
 * key is issued. Idempotent.
 */
export async function provisionInventoryKey(
  env: ProvisionEnv,
): Promise<ProvisionOutcome> {
  const outcome = await provisionKey(env, INVENTORY_SPEC, env.inventoryKeyFile);
  return outcome === "reissued" ? "created" : outcome;
}

/**
 * Make sure the relay key file holds a working key restricted to the model
 * management routes. A valid key is kept untouched; otherwise the alias is
 * revoked and a new key is issued. Idempotent.
 */
export async function provisionRelayKey(
  env: ProvisionEnv,
): Promise<ProvisionOutcome> {
  return provisionKey(env, RELAY_SPEC, env.relayKeyFile);
}

export async function provisionKeys(
  env: ProvisionEnv,
): Promise<{ inventory: ProvisionOutcome; relay: ProvisionOutcome }> {
  return {
    inventory: await provisionInventoryKey(env),
    relay: await provisionRelayKey(env),
  };
}
