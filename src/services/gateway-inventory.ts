import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  gatewayObjects,
  resourceGatewayLinks,
  type GatewayObjectKind,
} from "../db/gateway-schema.js";
import { logger } from "../logger.js";
import { syncAndAnnounce } from "./gateway-inventory-sync.js";
import { listAccessibleResources } from "./resources/access.js";
import type { CallerApplication } from "./resources/application-scope.js";
import {
  gatewayNameOfLocator,
  litellmLocatorName,
  projectionOwners,
} from "./resources/uri.js";
import type { ResourceView } from "./resources/registry.js";

const LITELLM_SCHEMES = new Set(["llm", "agent", "mcp"]);

export interface GatewayEntitlementResource {
  resourceId: string;
  uri: string;
  scheme: string;
  kind: GatewayObjectKind;
  name: string;
  parentName: string;
  applicationSlug: string;
  ownerType: "user" | "application";
}

export interface GatewayEntitlements {
  models: string[];
  agents: string[];
  mcpServers: string[];
  mcpToolPermissions: Record<string, string[]>;
  resources: GatewayEntitlementResource[];
}

type InventoryTarget =
  | { kind: "model" | "agent"; name: string; parentName: "" }
  | { kind: "mcp_server"; name: string; parentName: "" }
  | { kind: "mcp_tool"; name: string; parentName: string };

export function gatewayTargetForResource(
  scheme: string,
  locator: string,
): InventoryTarget | null {
  if (!LITELLM_SCHEMES.has(scheme)) return null;
  const rest = gatewayNameOfLocator(locator);
  if (rest === null) return null;
  if (scheme === "llm") return { kind: "model", name: rest, parentName: "" };
  if (scheme === "agent") return { kind: "agent", name: rest, parentName: "" };
  const toolSeparator = rest.lastIndexOf("/tool/");
  if (toolSeparator > 0) {
    const parentName = rest.slice(0, toolSeparator);
    const name = rest.slice(toolSeparator + "/tool/".length);
    if (!parentName || !name) return null;
    return { kind: "mcp_tool", name, parentName };
  }
  return { kind: "mcp_server", name: rest, parentName: "" };
}

/**
 * Models are matched on the locator projection, with the same owner rule as the
 * candidate listing: a projection without an owner links to nothing.
 */
async function findModelObject(locatorName: string): Promise<string | null> {
  const models = await db
    .select({ id: gatewayObjects.id, objectName: gatewayObjects.objectName })
    .from(gatewayObjects)
    .where(
      and(eq(gatewayObjects.kind, "model"), eq(gatewayObjects.isActive, true)),
    );
  const owners = projectionOwners(models.map((model) => model.objectName));
  const claimants = models.filter(
    (model) => litellmLocatorName(model.objectName) === locatorName,
  );
  const owner = claimants.find((model) => owners.has(model.objectName));
  if (!owner && claimants.length > 0) {
    logger.warn(
      { locatorName },
      "[res] LiteLLM model locator is shared by several models; not linkable",
    );
  }
  return owner?.id ?? null;
}

export async function linkResourceToGatewayObject(
  resource: Pick<ResourceView, "id" | "scheme" | "locator">,
): Promise<boolean> {
  const target = gatewayTargetForResource(resource.scheme, resource.locator);
  if (!target) return false;
  const find = async () => {
    if (target.kind === "model") return findModelObject(target.name);
    const [row] = await db
      .select({ id: gatewayObjects.id })
      .from(gatewayObjects)
      .where(
        and(
          eq(gatewayObjects.kind, target.kind),
          eq(gatewayObjects.objectName, target.name),
          eq(gatewayObjects.parentName, target.parentName),
          eq(gatewayObjects.isActive, true),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  };
  let objectId = await find();
  if (!objectId) {
    try {
      await syncAndAnnounce();
    } catch (err) {
      logger.warn({ err }, "[res] inventory refresh during validation failed");
    }
    objectId = await find();
  }
  if (!objectId) return false;
  await db
    .insert(resourceGatewayLinks)
    .values({ resourceId: resource.id, gatewayObjectId: objectId })
    .onConflictDoUpdate({
      target: resourceGatewayLinks.resourceId,
      set: { gatewayObjectId: objectId },
    });
  return true;
}

/** What the subject may reach through one application, never the global view. */
export async function listGatewayEntitlements(
  userId: string,
  caller: CallerApplication,
): Promise<GatewayEntitlements> {
  const accessible = await listAccessibleResources({
    subjectId: userId,
    caller,
  });
  const lite = accessible.filter((item) => LITELLM_SCHEMES.has(item.scheme));
  if (lite.length === 0) {
    return {
      models: [],
      agents: [],
      mcpServers: [],
      mcpToolPermissions: {},
      resources: [],
    };
  }
  const links = await db
    .select({
      resourceId: resourceGatewayLinks.resourceId,
      kind: gatewayObjects.kind,
      litellmId: gatewayObjects.litellmId,
      objectName: gatewayObjects.objectName,
      parentName: gatewayObjects.parentName,
    })
    .from(resourceGatewayLinks)
    .innerJoin(
      gatewayObjects,
      and(
        eq(resourceGatewayLinks.gatewayObjectId, gatewayObjects.id),
        eq(gatewayObjects.isActive, true),
      ),
    )
    .where(
      inArray(
        resourceGatewayLinks.resourceId,
        lite.map((item) => item.resourceId),
      ),
    );
  const byResource = new Map(links.map((link) => [link.resourceId, link]));

  const models = new Set<string>();
  const agents = new Set<string>();
  const mcpServers = new Set<string>();
  const serverLevel = new Set<string>();
  const tools: Record<string, Set<string>> = {};
  const resources: GatewayEntitlementResource[] = [];

  for (const item of lite) {
    const link = byResource.get(item.resourceId);
    if (!link) continue;
    if (link.kind === "model") models.add(link.objectName);
    else if (link.kind === "agent") agents.add(link.litellmId);
    else if (link.kind === "mcp_server") {
      mcpServers.add(link.objectName);
      serverLevel.add(link.objectName);
    } else {
      mcpServers.add(link.parentName);
      (tools[link.parentName] ??= new Set()).add(link.objectName);
    }
    resources.push({
      resourceId: item.resourceId,
      uri: item.resourceUri,
      scheme: item.scheme,
      kind: link.kind,
      name: link.objectName,
      parentName: link.parentName,
      applicationSlug: item.applicationSlug,
      ownerType: item.ownerType,
    });
  }

  return {
    models: [...models],
    agents: [...agents],
    mcpServers: [...mcpServers],
    mcpToolPermissions: Object.fromEntries(
      Object.entries(tools)
        .filter(([server]) => !serverLevel.has(server))
        .map(([server, names]) => [server, [...names]]),
    ),
    resources,
  };
}
