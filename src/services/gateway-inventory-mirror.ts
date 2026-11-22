import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  gatewayObjects,
  type GatewayObjectKind,
} from "../db/gateway-schema.js";
import { logger } from "../logger.js";

const REQUEST_TIMEOUT_MS = 8_000;
const UPSERT_CHUNK = 100;

export class GatewayInventoryError extends Error {}

const modelSchema = z.object({
  id: z.string().min(1),
  owned_by: z.string().nullish(),
});
const modelListSchema = z.union([
  z.object({ data: z.array(modelSchema) }),
  z.array(modelSchema),
]);

const agentSchema = z.object({
  agent_id: z.string().min(1),
  agent_name: z.string().min(1),
  description: z.string().nullish(),
});
const agentListSchema = z.union([
  z.array(agentSchema),
  z.object({ agents: z.array(agentSchema) }).transform((value) => value.agents),
]);

const mcpServerSchema = z.object({
  server_id: z.string().min(1),
  server_name: z.string().nullish(),
  alias: z.string().nullish(),
  allowed_tools: z.array(z.string()).nullish(),
  tool_name_to_description: z.record(z.string(), z.unknown()).nullish(),
  status: z.string().nullish(),
  approval_status: z.string().nullish(),
});
const mcpListSchema = z.array(mcpServerSchema);

const modelDetailsSchema = z.object({
  data: z.array(
    z
      .object({
        model_name: z.string().min(1),
        litellm_params: z
          .object({ model: z.string().nullish() })
          .passthrough()
          .optional(),
        model_info: z
          .object({
            managed_by: z.string().nullish(),
            created_by: z.string().nullish(),
            client_id: z.string().nullish(),
            reverse_name: z.string().nullish(),
            tags: z.array(z.string()).optional(),
            mode: z.string().nullish(),
            supports_function_calling: z.boolean().nullish(),
            supports_vision: z.boolean().nullish(),
            supports_video_input: z.boolean().nullish(),
            supports_audio_input: z.boolean().nullish(),
            supports_audio_output: z.boolean().nullish(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  ),
});

interface ModelDetails {
  managedBy?: string;
  createdBy?: string;
  clientId?: string;
  reverseName?: string;
  router: boolean;
  tags: Set<string>;
  mode: string | null;
  supports: {
    functionCalling: boolean;
    vision: boolean;
    videoInput: boolean;
    audioInput: boolean;
    audioOutput: boolean;
  };
}

function mergeModelDetails(
  target: ModelDetails,
  info: z.infer<typeof modelDetailsSchema>["data"][number]["model_info"],
  litellmModel: string | null | undefined,
): void {
  target.router ||= isAutoRouter(litellmModel);
  if (!info) return;
  target.managedBy ??= info.managed_by ?? undefined;
  target.createdBy ??= info.created_by ?? undefined;
  target.clientId ??= info.client_id ?? undefined;
  target.reverseName ??= info.reverse_name ?? undefined;
  target.mode ??= info.mode ?? null;
  for (const tag of info.tags ?? []) target.tags.add(tag);
  target.supports.functionCalling ||= info.supports_function_calling === true;
  target.supports.vision ||= info.supports_vision === true;
  target.supports.videoInput ||= info.supports_video_input === true;
  target.supports.audioInput ||= info.supports_audio_input === true;
  target.supports.audioOutput ||= info.supports_audio_output === true;
}

// LiteLLM auto routers are deployments whose provider is the `auto_router` pseudo-provider.
function isAutoRouter(litellmModel: string | null | undefined): boolean {
  return (
    typeof litellmModel === "string" && litellmModel.startsWith("auto_router/")
  );
}

async function fetchModelDetails(): Promise<Map<string, ModelDetails>> {
  try {
    const parsed = modelDetailsSchema.parse(await gatewayGet("/model/info"));
    const details = new Map<string, ModelDetails>();
    for (const row of parsed.data) {
      const entry = details.get(row.model_name) ?? {
        router: false,
        tags: new Set<string>(),
        mode: null,
        supports: {
          functionCalling: false,
          vision: false,
          videoInput: false,
          audioInput: false,
          audioOutput: false,
        },
      };
      mergeModelDetails(entry, row.model_info, row.litellm_params?.model);
      details.set(row.model_name, entry);
    }
    return details;
  } catch (err) {
    // The listing still works without ownership details; provisioning the
    // inventory key with /model/info restores them.
    logger.warn({ err }, "[res] LiteLLM model details are unavailable");
    return new Map();
  }
}

interface InventoryRow {
  kind: GatewayObjectKind;
  litellmId: string;
  objectName: string;
  parentName: string;
  displayName: string;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

function readInventoryKey(): string {
  try {
    const key = readFileSync(config.litellm.inventoryKeyFile, "utf8").trim();
    if (key) return key;
  } catch {
    // reported below
  }
  throw new GatewayInventoryError(
    "the gateway inventory key is not available yet (is litellm-provision done?)",
  );
}

async function gatewayGet(path: string): Promise<unknown> {
  if (!config.litellm.url)
    throw new GatewayInventoryError("LITELLM_URL is not set");
  let res: Response;
  try {
    res = await fetch(`${config.litellm.url}${path}`, {
      headers: { Authorization: `Bearer ${readInventoryKey()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GatewayInventoryError(`gateway unreachable: ${String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new GatewayInventoryError(
      `gateway inventory ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new GatewayInventoryError(
      `gateway inventory ${path} returned invalid JSON`,
    );
  }
}

function activeMcpServer(server: z.infer<typeof mcpServerSchema>): boolean {
  if (server.status === "inactive" || server.status === "disabled")
    return false;
  if (server.approval_status === "rejected") return false;
  return true;
}

async function fetchInventory(): Promise<InventoryRow[]> {
  const [modelsRaw, agentsRaw, mcpRaw, details] = await Promise.all([
    gatewayGet("/v1/models"),
    gatewayGet("/v1/agents"),
    gatewayGet("/v1/mcp/server"),
    fetchModelDetails(),
  ]);

  const rows = new Map<string, InventoryRow>();
  const parsedModels = modelListSchema.parse(modelsRaw);
  const models = Array.isArray(parsedModels) ? parsedModels : parsedModels.data;
  for (const model of models) {
    const detail = details.get(model.id);
    rows.set(`model:${model.id}`, {
      kind: "model",
      litellmId: model.id,
      objectName: model.id,
      parentName: "",
      displayName: model.id,
      isActive: true,
      metadata: {
        ...(model.owned_by ? { ownedBy: model.owned_by } : {}),
        ...(detail
          ? {
              managedBy: detail.managedBy,
              createdBy: detail.createdBy,
              clientId: detail.clientId,
              reverseName: detail.reverseName,
              router: detail.router,
              tags: [...detail.tags].sort(),
              mode: detail.mode,
              supports: detail.supports,
            }
          : {}),
      },
    });
  }
  for (const agent of agentListSchema.parse(agentsRaw)) {
    rows.set(`agent:${agent.agent_id}`, {
      kind: "agent",
      litellmId: agent.agent_id,
      objectName: agent.agent_name,
      parentName: "",
      displayName: agent.agent_name,
      isActive: true,
      metadata: agent.description ? { description: agent.description } : {},
    });
  }
  for (const server of mcpListSchema.parse(mcpRaw)) {
    const serverName = server.server_name || server.alias || server.server_id;
    const active = activeMcpServer(server);
    rows.set(`mcp_server:${server.server_id}`, {
      kind: "mcp_server",
      litellmId: server.server_id,
      objectName: serverName,
      parentName: "",
      displayName: serverName,
      isActive: active,
      metadata: { serverId: server.server_id },
    });
    const tools = new Set([
      ...(server.allowed_tools ?? []),
      ...Object.keys(server.tool_name_to_description ?? {}),
    ]);
    for (const tool of tools) {
      rows.set(`mcp_tool:${server.server_id}:${tool}`, {
        kind: "mcp_tool",
        litellmId: `${server.server_id}:${tool}`,
        objectName: tool,
        parentName: serverName,
        displayName: `${serverName}/${tool}`,
        isActive: active,
        metadata: { serverId: server.server_id, serverName },
      });
    }
  }
  return [...rows.values()];
}

/**
 * Mirror the gateway inventory. A failed fetch leaves the previous mirror intact.
 * `changed` is true when the set of active models differs before and after.
 */
export async function syncGatewayInventory(): Promise<{
  count: number;
  changed: boolean;
}> {
  if (!config.litellm.url) return { count: 0, changed: false };
  const syncStartedAt = new Date();
  const rows = await fetchInventory();
  const before = await modelFingerprint();
  await db.transaction(async (tx) => {
    // Retire every mirrored row first so a provider id change cannot collide
    // with the still-active row that holds the same name.
    await tx
      .update(gatewayObjects)
      .set({ isActive: false, updatedAt: syncStartedAt });
    for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
      const chunk = rows.slice(index, index + UPSERT_CHUNK);
      await tx
        .insert(gatewayObjects)
        .values(
          chunk.map((row) => ({
            ...row,
            lastSeenAt: syncStartedAt,
            updatedAt: syncStartedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [gatewayObjects.kind, gatewayObjects.litellmId],
          set: {
            objectName: sql`excluded.object_name`,
            parentName: sql`excluded.parent_name`,
            displayName: sql`excluded.display_name`,
            isActive: sql`excluded.is_active`,
            lastSeenAt: syncStartedAt,
            metadata: sql`excluded.metadata`,
            updatedAt: syncStartedAt,
          },
        });
    }
    // Retired rows keep their name while a replacement takes over: move the
    // links so already-validated resources stay entitled across the id change.
    await tx.execute(sql`
      UPDATE "resource_gateway_links" AS l
      SET "gateway_object_id" = active."id"
      FROM "gateway_objects" AS retired
      JOIN "gateway_objects" AS active
        ON active."kind" = retired."kind"
       AND active."object_name" = retired."object_name"
       AND active."parent_name" = retired."parent_name"
       AND active."is_active" = true
       AND active."id" <> retired."id"
      WHERE l."gateway_object_id" = retired."id"
        AND retired."is_active" = false
    `);
  });
  const after = await modelFingerprint();
  return { count: rows.length, changed: before !== after };
}

async function modelFingerprint(): Promise<string> {
  const models = await listGatewayModels();
  return models
    .map((model) => JSON.stringify([model.name, model.metadata]))
    .sort()
    .join("\n");
}

export interface GatewayModel {
  name: string;
  metadata: Record<string, unknown>;
}

/** Active models as the inventory mirror last saw them. */
export async function listGatewayModels(): Promise<GatewayModel[]> {
  const rows = await db
    .select({
      name: gatewayObjects.objectName,
      metadata: gatewayObjects.metadata,
    })
    .from(gatewayObjects)
    .where(
      and(eq(gatewayObjects.kind, "model"), eq(gatewayObjects.isActive, true)),
    )
    .orderBy(gatewayObjects.objectName);
  return rows;
}
