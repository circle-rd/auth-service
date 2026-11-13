import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Gateway user that owns the team key, and the key's alias. */
export const PROVISIONER_USER_ID = "auth-service-provisioner";
export const PROVISIONER_KEY_ALIAS = "auth-service-provisioner";

/** Gateway user that owns the shared-resource access-group key. */
export const RESOURCE_SYNC_USER_ID = "auth-service-resource-sync";
export const RESOURCE_SYNC_KEY_ALIAS = "auth-service-resource-sync";

/**
 * Routes of the team provisioner: one team per application plan plus the
 * access groups those teams carry. It cannot add models, mint keys or call LLMs.
 * `allowed_routes` matches the path only (LiteLLM v1.108.3), never the method.
 */
export const PROVISIONER_ROUTES = [
  "/team/new",
  "/team/info",
  "/team/list",
  "/team/update",
  "/team/block",
  "/team/unblock",
  "/team/delete",
  "/v1/access_group",
  "/v1/access_group/*",
];

/**
 * Routes of the shared-resource sync key. It reads access groups and updates
 * their membership, nothing else: no team, model, key or LLM route.
 */
export const RESOURCE_SYNC_ROUTES = ["/v1/access_group", "/v1/access_group/*"];

const provisionEnvSchema = z.object({
  LITELLM_URL: z.string().url(),
  LITELLM_PROVISIONER_KEY_FILE: z.string().min(1),
  LITELLM_RESOURCE_SYNC_KEY_FILE: z.string().min(1).optional(),
  LITELLM_STATE_FILE: z.string().min(1),
});

export interface ProvisionEnv {
  gatewayUrl: string;
  keyFile: string;
  resourceSyncKeyFile: string;
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
  const keyFile = parsed.data.LITELLM_PROVISIONER_KEY_FILE;
  return {
    gatewayUrl: parsed.data.LITELLM_URL.replace(/\/+$/, ""),
    keyFile,
    resourceSyncKeyFile:
      parsed.data.LITELLM_RESOURCE_SYNC_KEY_FILE ??
      join(dirname(keyFile), "resource-sync-key"),
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

interface KeySpec {
  userId: string;
  keyAlias: string;
  routes: readonly string[];
  keyFile: string;
  /** A working, correctly scoped key must answer each probe with this status. */
  probes: ReadonlyArray<{ path: string; status: number }>;
}

const TEAM_KEY: Omit<KeySpec, "keyFile"> = {
  userId: PROVISIONER_USER_ID,
  keyAlias: PROVISIONER_KEY_ALIAS,
  routes: PROVISIONER_ROUTES,
  probes: [{ path: "/v1/access_group", status: 200 }],
};

const RESOURCE_SYNC_KEY: Omit<KeySpec, "keyFile"> = {
  userId: RESOURCE_SYNC_USER_ID,
  keyAlias: RESOURCE_SYNC_KEY_ALIAS,
  routes: RESOURCE_SYNC_ROUTES,
  probes: [
    { path: "/v1/access_group", status: 200 },
    // Negative probes: this key must not reach team or model administration.
    { path: "/team/list", status: 403 },
    { path: "/model/info", status: 403 },
  ],
};

async function scopeMatches(
  env: ProvisionEnv,
  key: string,
  spec: Omit<KeySpec, "keyFile">,
): Promise<boolean> {
  for (const probe of spec.probes) {
    const answer = await gatewayCall(env, key, "GET", probe.path);
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

async function ensureAdministrator(
  env: ProvisionEnv,
  masterKey: string,
  userId: string,
): Promise<void> {
  // LiteLLM denies access-group writes to a key whose owner is not an
  // administrator. Creating an existing user fails: that is fine.
  const user = await gatewayCall(env, masterKey, "POST", "/user/new", {
    user_id: userId,
    user_role: "proxy_admin",
    auto_create_key: false,
  });
  if (
    user.status >= 300 &&
    !/already exists|duplicate|unique/i.test(user.text)
  ) {
    throw new Error(`user creation failed: HTTP ${user.status} ${user.text}`);
  }
}

async function issueKey(
  env: ProvisionEnv,
  masterKey: string,
  spec: Omit<KeySpec, "keyFile">,
): Promise<string> {
  await ensureAdministrator(env, masterKey, spec.userId);

  // Revoke what an earlier run left (an unusable file, or a lost one). Nothing
  // to revoke is not an error.
  await gatewayCall(env, masterKey, "POST", "/key/delete", {
    key_aliases: [spec.keyAlias],
  });

  const issued = await gatewayCall(env, masterKey, "POST", "/key/generate", {
    user_id: spec.userId,
    key_alias: spec.keyAlias,
    allowed_routes: spec.routes,
  });
  if (issued.status >= 300) {
    throw new Error(
      `key creation failed: HTTP ${issued.status} ${issued.text}`,
    );
  }
  return keyResponseSchema.parse(JSON.parse(issued.text)).key;
}

/**
 * Make sure the key file holds a working, correctly scoped gateway key. A key
 * that still works is kept; otherwise the previous alias is revoked and a new
 * key is issued, so a single key with this alias ever exists. Idempotent.
 */
async function provisionScopedKey(
  env: ProvisionEnv,
  spec: Omit<KeySpec, "keyFile">,
  keyFile: string,
): Promise<ProvisionOutcome> {
  const existing = readFileOrNull(keyFile)?.trim();
  if (existing && (await scopeMatches(env, existing, spec))) return "kept";

  const masterKey = masterKeyOf(env);
  const key = await issueKey(env, masterKey, spec);
  if (!(await scopeMatches(env, key, spec))) {
    // Fail closed: a key wider than its requested allowlist must not be kept.
    await gatewayCall(env, masterKey, "POST", "/key/delete", {
      key_aliases: [spec.keyAlias],
    });
    throw new Error(
      `key '${spec.keyAlias}' does not enforce its access-group scope`,
    );
  }

  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${key}\n`, { mode: 0o644 });
  return "created";
}

export function provisionKey(env: ProvisionEnv): Promise<ProvisionOutcome> {
  return provisionScopedKey(env, TEAM_KEY, env.keyFile);
}

export function provisionResourceSyncKey(
  env: ProvisionEnv,
): Promise<ProvisionOutcome> {
  return provisionScopedKey(env, RESOURCE_SYNC_KEY, env.resourceSyncKeyFile);
}

export async function provisionKeys(
  env: ProvisionEnv,
): Promise<{ team: ProvisionOutcome; resourceSync: ProvisionOutcome }> {
  return {
    team: await provisionKey(env),
    resourceSync: await provisionResourceSyncKey(env),
  };
}
