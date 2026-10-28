/**
 * Client for the LLM gateway (LiteLLM) administration API.
 *
 * auth-service only decides that a team *exists* for an application's plan (and
 * whether it is blocked), and that the plan has an access group to carry it.
 * What the team actually reaches — models, MCP servers, agents — is set by a
 * gateway administrator on the access group and is never overwritten here. The
 * credential is a virtual key restricted to the team and access-group routes,
 * delivered as a file by `litellm-provision`.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "../config.js";

/** Marks a team auth-service manages, and remembers that it blocked it itself. */
export const MANAGED_BY = "auth-service";
const BLOCKED_BY_US = "blocked_by_auth_service";

/** A team with no model: nothing is reachable until an administrator grants some. */
const NO_MODELS = ["no-default-models"];

const REQUEST_TIMEOUT_MS = 8_000;

export class LitellmGatewayError extends Error {}

const teamSchema = z.object({
  team_id: z.string(),
  blocked: z.boolean().nullish(),
  access_group_ids: z.array(z.string()).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type GatewayTeam = z.infer<typeof teamSchema>;

const accessGroupSchema = z.object({
  access_group_id: z.string(),
  access_group_name: z.string(),
});
export type GatewayAccessGroup = z.infer<typeof accessGroupSchema>;

export function isGatewayConfigured(): boolean {
  return config.litellm.url !== undefined;
}

function readKey(): string {
  try {
    const key = readFileSync(config.litellm.provisionerKeyFile, "utf8").trim();
    if (key) return key;
  } catch {
    // reported below
  }
  throw new LitellmGatewayError(
    "the gateway provisioning key is not available yet (is litellm-provision done?)",
  );
}

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  if (!config.litellm.url) {
    throw new LitellmGatewayError("LITELLM_URL is not set");
  }
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
    if (err instanceof LitellmGatewayError) throw err;
    throw new LitellmGatewayError(`gateway unreachable: ${String(err)}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function describe(json: unknown): string {
  return typeof json === "string" ? json : JSON.stringify(json).slice(0, 300);
}

async function expectOk(
  what: string,
  r: { status: number; json: unknown },
): Promise<unknown> {
  if (r.status >= 200 && r.status < 300) return r.json;
  throw new LitellmGatewayError(
    `${what} failed: HTTP ${r.status} ${describe(r.json)}`,
  );
}

function unwrapTeam(json: unknown): GatewayTeam {
  const wrapped = z.object({ team_info: teamSchema }).safeParse(json);
  return wrapped.success ? wrapped.data.team_info : teamSchema.parse(json);
}

/** The team, or null when it does not exist. */
export async function getTeam(teamId: string): Promise<GatewayTeam | null> {
  const r = await call(
    "GET",
    `/team/info?team_id=${encodeURIComponent(teamId)}`,
  );
  // LiteLLM answers an unknown team with 404, or with another error saying so.
  if (
    r.status >= 400 &&
    (r.status === 404 ||
      /not found|does(n't| not) exist/i.test(describe(r.json)))
  ) {
    return null;
  }
  return unwrapTeam(await expectOk("team lookup", r));
}

async function setMetadata(
  team: GatewayTeam,
  patch: Record<string, unknown>,
): Promise<void> {
  await expectOk(
    "team update",
    await call("POST", "/team/update", {
      team_id: team.team_id,
      metadata: { ...(team.metadata ?? {}), ...patch },
    }),
  );
}

/**
 * Every access group the gateway knows, by id and name. LiteLLM answers with a
 * bare array (older builds wrapped it in `access_groups`), so both are accepted.
 */
export async function listAccessGroups(): Promise<GatewayAccessGroup[]> {
  const json = await expectOk(
    "access group list",
    await call("GET", "/v1/access_group"),
  );
  return z
    .union([
      z.array(accessGroupSchema),
      z
        .object({ access_groups: z.array(accessGroupSchema) })
        .transform((o) => o.access_groups),
    ])
    .parse(json);
}

/**
 * The access group carrying a plan's resources, created empty when missing: the
 * name is the team id, so it is unique per application and plan.
 */
export async function ensureAccessGroup(name: string): Promise<string> {
  const existing = (await listAccessGroups()).find(
    (g) => g.access_group_name === name,
  );
  if (existing) return existing.access_group_id;
  const json = await expectOk(
    "access group creation",
    await call("POST", "/v1/access_group", {
      access_group_name: name,
      description: `Managed by auth-service for the plan '${name}'.`,
    }),
  );
  return accessGroupSchema.parse(json).access_group_id;
}

/** Delete a plan's access group (no-op if absent). */
export async function deleteAccessGroupByName(name: string): Promise<void> {
  const existing = (await listAccessGroups()).find(
    (g) => g.access_group_name === name,
  );
  if (!existing) return;
  await expectOk(
    "access group deletion",
    await call("DELETE", `/v1/access_group/${existing.access_group_id}`),
  );
}

/**
 * Make sure a plan's team exists and is usable, and that its access group is
 * attached. A new team is closed (no model). An existing one keeps its whole
 * configuration; it is only adopted, its access group added, and unblocked when
 * auth-service itself blocked it before — a block set by a gateway
 * administrator stays.
 */
export async function ensurePlanTeam(
  teamId: string,
  alias: string,
  accessGroupName: string,
): Promise<void> {
  const accessGroupId = await ensureAccessGroup(accessGroupName);
  const existing = await getTeam(teamId);

  if (!existing) {
    await expectOk(
      "team creation",
      await call("POST", "/team/new", {
        team_id: teamId,
        team_alias: alias,
        models: NO_MODELS,
        access_group_ids: [accessGroupId],
        metadata: { managed_by: MANAGED_BY },
      }),
    );
    return;
  }

  if (existing.metadata?.[BLOCKED_BY_US] === true) {
    await expectOk(
      "team unblock",
      await call("POST", "/team/unblock", { team_id: teamId }),
    );
    await setMetadata(existing, {
      managed_by: MANAGED_BY,
      [BLOCKED_BY_US]: false,
    });
  } else if (existing.metadata?.managed_by !== MANAGED_BY) {
    await setMetadata(existing, { managed_by: MANAGED_BY });
  }

  const groups = existing.access_group_ids ?? [];
  if (!groups.includes(accessGroupId)) {
    await expectOk(
      "team access group attach",
      await call("POST", "/team/update", {
        team_id: teamId,
        access_group_ids: [...groups, accessGroupId],
      }),
    );
  }
}

/** Block a plan's team (no-op if absent or already blocked). */
export async function blockTeam(teamId: string): Promise<void> {
  const existing = await getTeam(teamId);
  if (!existing || existing.blocked) return;
  await setMetadata(existing, {
    managed_by: MANAGED_BY,
    [BLOCKED_BY_US]: true,
  });
  await expectOk(
    "team block",
    await call("POST", "/team/block", { team_id: teamId }),
  );
}

/** Delete a plan's team (no-op if absent). */
export async function deleteTeam(teamId: string): Promise<void> {
  if (!(await getTeam(teamId))) return;
  await expectOk(
    "team deletion",
    await call("POST", "/team/delete", { team_ids: [teamId] }),
  );
}

/** Every team the gateway knows. */
export async function listTeams(): Promise<GatewayTeam[]> {
  const json = await expectOk("team list", await call("GET", "/team/list"));
  const list = z
    .union([
      z.array(teamSchema),
      z.object({ teams: z.array(teamSchema) }).transform((o) => o.teams),
    ])
    .parse(json);
  return list;
}
