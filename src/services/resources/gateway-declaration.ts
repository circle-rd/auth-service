import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { gatewayObjects } from "../../db/gateway-schema.js";
import {
  gatewayTargetForResource,
  linkResourceToGatewayObject,
} from "../gateway-inventory.js";
import { adapterForScheme } from "./uri.js";
import { isRelayDeclaration } from "./provenance.js";
import { markResourceValidated, type ResourceView } from "./registry.js";

/**
 * Validates a model, agent or MCP server declared by its own account when the
 * relay wrote it for that account. Anything else stays `pending_validation`
 * until a platform administrator decides.
 */
export async function validateRelayDeclaration(
  resource: ResourceView,
  username: string | null,
): Promise<ResourceView> {
  if (username === null || resource.ownerType !== "user") return resource;
  if (adapterForScheme(resource.scheme) !== "litellm") return resource;
  const target = gatewayTargetForResource(resource.scheme, resource.locator);
  if (!target) return resource;

  const [object] = await db
    .select({ metadata: gatewayObjects.metadata })
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
  if (!object || !isRelayDeclaration(object.metadata, target.name, username)) {
    return resource;
  }
  if (!(await linkResourceToGatewayObject(resource))) return resource;
  return markResourceValidated(resource.id);
}
