/**
 * Gateway client for shared-resource access-group membership.
 *
 * Uses its own credential, never the team provisioner key. Only the
 * access-group list and update routes are reachable; method restrictions are
 * enforced here because LiteLLM v1.108.3 matches `allowed_routes` by path.
 * `upstream_ref` values are opaque identifiers sent in JSON, never fetched as
 * URLs. Error messages carry no key, owner, upstream reference or secret.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../../config.js";
import { resourceSyncMethodAllowed } from "./litellm-scope.js";

const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [100, 300];

const accessGroupSchema = z.object({
  access_group_id: z.string().min(1),
  access_group_name: z.string().min(1),
  access_model_names: z.array(z.string()).nullish(),
  access_mcp_server_ids: z.array(z.string()).nullish(),
  access_agent_ids: z.array(z.string()).nullish(),
});

export interface ResourceAccessGroup {
  id: string;
  name: string;
  modelNames: string[];
  mcpServerIds: string[];
  agentIds: string[];
}

export class LitellmResourceSyncError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "LitellmResourceSyncError";
  }
}

export function isResourceSyncActive(): boolean {
  return Boolean(config.features.resourceSharing && config.litellm.url);
}

function readKey(): string {
  let key: string;
  try {
    key = readFileSync(config.litellm.resourceSyncKeyFile, "utf8").trim();
  } catch {
    key = "";
  }
  if (!key) {
    throw new LitellmResourceSyncError(
      "the resource-sync gateway key is unavailable (is litellm-provision done?)",
      false,
    );
  }
  return key;
}

/** Startup guard: sharing sync needs its own key file before serving. */
export function assertResourceSyncReady(): void {
  if (!isResourceSyncActive()) return;
  readKey();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new LitellmResourceSyncError(
      "gateway returned a non-JSON response",
      false,
    );
  }
}

async function call(
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!resourceSyncMethodAllowed(method, path)) {
    throw new LitellmResourceSyncError(
      `route not allowed by the resource-sync credential: ${method} ${path}`,
      false,
    );
  }
  if (!config.litellm.url) {
    throw new LitellmResourceSyncError("LITELLM_URL is not set", false);
  }

  let lastError = new LitellmResourceSyncError("gateway request failed", true);
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
    let res: Response;
    try {
      res = await fetch(`${config.litellm.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${readKey()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof LitellmResourceSyncError) throw err;
      lastError = new LitellmResourceSyncError(
        "gateway unreachable while syncing shared resources",
        true,
      );
      continue;
    }

    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      return text === "" ? null : parseJson(text);
    }
    if (isTransientStatus(res.status)) {
      lastError = new LitellmResourceSyncError(
        `gateway ${method} ${path} failed: HTTP ${res.status}`,
        true,
      );
      continue;
    }
    throw new LitellmResourceSyncError(
      `gateway ${method} ${path} failed: HTTP ${res.status}`,
      false,
    );
  }
  throw lastError;
}

function toGroup(json: unknown): ResourceAccessGroup {
  const parsed = accessGroupSchema.safeParse(json);
  if (!parsed.success) {
    throw new LitellmResourceSyncError(
      "gateway returned an invalid access group",
      false,
    );
  }
  return {
    id: parsed.data.access_group_id,
    name: parsed.data.access_group_name,
    modelNames: parsed.data.access_model_names ?? [],
    mcpServerIds: parsed.data.access_mcp_server_ids ?? [],
    agentIds: parsed.data.access_agent_ids ?? [],
  };
}

/** Every access group, accepting the bare array and the wrapped legacy shape. */
export async function listAccessGroups(): Promise<ResourceAccessGroup[]> {
  const json = await call("GET", "/v1/access_group");
  const parsed = z
    .union([
      z.array(z.unknown()),
      z
        .object({ access_groups: z.array(z.unknown()) })
        .transform((o) => o.access_groups),
    ])
    .safeParse(json);
  if (!parsed.success) {
    throw new LitellmResourceSyncError(
      "gateway returned an invalid access-group list",
      false,
    );
  }
  return parsed.data.map(toGroup);
}

export interface AccessGroupMembersPatch {
  access_model_names?: string[];
  access_mcp_server_ids?: string[];
  access_agent_ids?: string[];
}

/** Replace only the membership fields supplied; other group fields are kept. */
export async function updateAccessGroupMembers(
  accessGroupId: string,
  patch: AccessGroupMembersPatch,
): Promise<ResourceAccessGroup> {
  const body = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const json = await call(
    "PUT",
    `/v1/access_group/${encodeURIComponent(accessGroupId)}`,
    body,
  );
  return toGroup(json);
}
