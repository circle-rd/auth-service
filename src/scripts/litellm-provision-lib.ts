import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** Gateway user that owns the key, and the key's alias (a single one at a time). */
export const PROVISIONER_USER_ID = "auth-service-provisioner";
export const PROVISIONER_KEY_ALIAS = "auth-service-provisioner";

/**
 * The only gateway routes the key may call: the team routes auth-service needs to
 * keep one team per application. It cannot add models, mint keys or serve calls.
 */
export const PROVISIONER_ROUTES = [
  "/team/new",
  "/team/info",
  "/team/list",
  "/team/update",
  "/team/block",
  "/team/unblock",
  "/team/delete",
];

const provisionEnvSchema = z.object({
  LITELLM_URL: z.string().url(),
  LITELLM_PROVISIONER_KEY_FILE: z.string().min(1),
  LITELLM_STATE_FILE: z.string().min(1),
});

export interface ProvisionEnv {
  gatewayUrl: string;
  keyFile: string;
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
    keyFile: parsed.data.LITELLM_PROVISIONER_KEY_FILE,
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

/**
 * Make sure the key file holds a working team-routes-only gateway key. A key that
 * still works is kept; otherwise the previous one (if any) is revoked and a new
 * one is issued, so a single key with this alias ever exists. Idempotent.
 */
export async function provisionKey(
  env: ProvisionEnv,
): Promise<ProvisionOutcome> {
  const existing = readFileOrNull(env.keyFile)?.trim();
  if (existing) {
    const probe = await gatewayCall(env, existing, "GET", "/team/list");
    if (probe.status === 200) return "kept";
  }

  const stateFile = readFileOrNull(env.stateFile);
  const masterKey = stateFile
    ? /^LITELLM_MASTER_KEY=(.+)$/m.exec(stateFile)?.[1]?.trim()
    : undefined;
  if (!masterKey) {
    throw new Error(
      `LITELLM_MASTER_KEY not found in ${env.stateFile} (has litellm-setup run?)`,
    );
  }

  // The owner must be an administrator, or LiteLLM denies the key access to teams
  // it did not create. Creating an existing user fails: that is fine.
  const user = await gatewayCall(env, masterKey, "POST", "/user/new", {
    user_id: PROVISIONER_USER_ID,
    user_role: "proxy_admin",
    auto_create_key: false,
  });
  if (
    user.status >= 300 &&
    !/already exists|duplicate|unique/i.test(user.text)
  ) {
    throw new Error(`user creation failed: HTTP ${user.status} ${user.text}`);
  }

  // Revoke what an earlier run left (an unusable file, or a lost one). Nothing to
  // revoke is not an error.
  await gatewayCall(env, masterKey, "POST", "/key/delete", {
    key_aliases: [PROVISIONER_KEY_ALIAS],
  });

  const issued = await gatewayCall(env, masterKey, "POST", "/key/generate", {
    user_id: PROVISIONER_USER_ID,
    key_alias: PROVISIONER_KEY_ALIAS,
    allowed_routes: PROVISIONER_ROUTES,
  });
  if (issued.status >= 300) {
    throw new Error(
      `key creation failed: HTTP ${issued.status} ${issued.text}`,
    );
  }
  const { key } = keyResponseSchema.parse(JSON.parse(issued.text));

  mkdirSync(dirname(env.keyFile), { recursive: true });
  writeFileSync(env.keyFile, `${key}\n`, { mode: 0o644 });
  return "created";
}
