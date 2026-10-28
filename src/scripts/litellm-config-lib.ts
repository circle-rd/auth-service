/**
 * Export and import of the gateway (LiteLLM) "administrator" layer: the models
 * and their access groups. Teams are never touched — auth-service owns them —
 * and provider secrets never appear here: a model references a reusable LLM
 * Credential by name (`litellm_params.litellm_credential_name`), so an
 * administrator recreates the credentials once and re-imports the same file.
 */

import { z } from "zod";

const paramsSchema = z.record(z.string(), z.unknown());

export const gatewayModelSchema = z.object({
  model_name: z.string().min(1),
  litellm_params: paramsSchema,
  model_info: paramsSchema.optional(),
});

export const gatewayAccessGroupSchema = z.object({
  access_group_name: z.string().min(1),
  description: z.string().optional(),
  access_model_names: z.array(z.string()).optional(),
  access_mcp_server_ids: z.array(z.string()).optional(),
  access_agent_ids: z.array(z.string()).optional(),
});

export const gatewayConfigSchema = z.object({
  models: z.array(gatewayModelSchema).default([]),
  access_groups: z.array(gatewayAccessGroupSchema).default([]),
});

export type GatewayModel = z.infer<typeof gatewayModelSchema>;
export type GatewayAccessGroup = z.infer<typeof gatewayAccessGroupSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/** Fields LiteLLM adds to a model at runtime: never part of a declarative file. */
const VOLATILE_MODEL_INFO = new Set([
  "id",
  "db_model",
  "created_at",
  "updated_at",
  "updated_by",
]);

/**
 * Provider credential fields LiteLLM accepts inline. A declarative file must
 * never carry them — a model references a reusable LLM Credential by name
 * (`litellm_credential_name`). Redacting by list rather than only `api_key`
 * keeps AWS/Vertex/Azure/Watsonx secrets out of the export too.
 */
const SECRET_PARAM_KEYS = [
  "api_key",
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "azure_ad_token",
  "azure_key",
  "vertex_credentials",
  "vertex_key",
  "watsonx_api_key",
  "watsonx_token",
  "huggingface_key",
] as const;

/** Drop `user:password@` credentials embedded in a URL, if any. */
function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A `GET /model/info` entry, as the export reads it. */
export interface ModelInfoEntry {
  model_name: string;
  litellm_params: Record<string, unknown>;
  model_info?: Record<string, unknown>;
}

/**
 * Strip a model info entry down to what a declarative file should carry: every
 * provider credential is removed (the model references a credential by name),
 * and the ids and timestamps the gateway assigns are dropped.
 */
export function toExportModel(entry: ModelInfoEntry): GatewayModel {
  const params = { ...entry.litellm_params };
  for (const key of SECRET_PARAM_KEYS) delete params[key];
  if (typeof params.api_base === "string") {
    params.api_base = stripUrlCredentials(params.api_base);
  }
  const info: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.model_info ?? {})) {
    if (!VOLATILE_MODEL_INFO.has(key)) info[key] = value;
  }
  return {
    model_name: entry.model_name,
    litellm_params: params,
    ...(Object.keys(info).length > 0 ? { model_info: info } : {}),
  };
}

export interface ModelImportAction {
  kind: "create" | "update";
  model: GatewayModel;
  /** The gateway id of the model to update; present only for `update`. */
  id?: string;
}

/** Match each desired model against the deployed ones, by `model_name`. */
export function planModelImport(
  deployed: Array<{ model_name: string; model_info?: { id?: string } }>,
  desired: GatewayModel[],
): ModelImportAction[] {
  const byName = new Map(deployed.map((m) => [m.model_name, m]));
  return desired.map((model) => {
    const found = byName.get(model.model_name);
    return found
      ? { kind: "update", model, id: found.model_info?.id }
      : { kind: "create", model };
  });
}

export interface GatewayClient {
  base: string;
  masterKey: string;
}

async function call(
  client: GatewayClient,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${client.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${client.masterKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

const modelInfoSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string(),
      litellm_params: paramsSchema,
      model_info: paramsSchema.optional(),
    }),
  ),
});

const accessGroupWithIdSchema = gatewayAccessGroupSchema.extend({
  access_group_id: z.string(),
});

// LiteLLM answers `GET /v1/access_group` with a bare array (older builds wrapped
// it in `access_groups`), so both are accepted.
const accessGroupsListSchema = z.union([
  z.array(accessGroupWithIdSchema),
  z
    .object({ access_groups: z.array(accessGroupWithIdSchema) })
    .transform((o) => o.access_groups),
]);

/** Read the models and access groups off a running gateway. */
export async function exportGatewayConfig(
  client: GatewayClient,
): Promise<GatewayConfig> {
  const models = modelInfoSchema.parse(
    await call(client, "GET", "/model/info"),
  );
  const groups = accessGroupsListSchema.parse(
    await call(client, "GET", "/v1/access_group"),
  );
  return {
    models: models.data.map(toExportModel),
    access_groups: groups.map(({ access_group_id: _id, ...group }) => group),
  };
}

export interface ImportReport {
  modelsCreated: string[];
  modelsUpdated: string[];
  groupsCreated: string[];
  groupsUpdated: string[];
}

/**
 * Apply a declarative file: upsert every model (by `model_name`) and access
 * group (by name). Never deletes, never touches teams.
 */
export async function importGatewayConfig(
  client: GatewayClient,
  config: GatewayConfig,
): Promise<ImportReport> {
  const report: ImportReport = {
    modelsCreated: [],
    modelsUpdated: [],
    groupsCreated: [],
    groupsUpdated: [],
  };

  const deployed = modelInfoSchema.parse(
    await call(client, "GET", "/model/info"),
  );
  for (const action of planModelImport(deployed.data, config.models)) {
    const { model_info, model_name, litellm_params } = action.model;
    if (action.kind === "create") {
      await call(client, "POST", "/model/new", {
        model_name,
        litellm_params,
        ...(model_info ? { model_info } : {}),
      });
      report.modelsCreated.push(model_name);
    } else {
      await call(client, "POST", "/model/update", {
        model_name,
        litellm_params,
        model_info: { ...model_info, id: action.id },
      });
      report.modelsUpdated.push(model_name);
    }
  }

  const existing = await call(client, "GET", "/v1/access_group");
  const byName = new Map(
    accessGroupsListSchema
      .parse(existing)
      .map((g) => [g.access_group_name, g.access_group_id]),
  );
  for (const group of config.access_groups) {
    const id = byName.get(group.access_group_name);
    if (id) {
      await call(client, "PUT", `/v1/access_group/${id}`, group);
      report.groupsUpdated.push(group.access_group_name);
    } else {
      await call(client, "POST", "/v1/access_group", group);
      report.groupsCreated.push(group.access_group_name);
    }
  }
  return report;
}
