import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { gatewayObjects, resourceGatewayLinks } from "../db/gateway-schema.js";
import { logger } from "../logger.js";

const MAX_HARDWARE_ENTRIES = 16;
const MAX_GPUS = 8;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

// The relay forwards what the agent read from its host: the text is untrusted.
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(CONTROL_CHARACTERS, "").trim())
    .pipe(z.string().min(1).max(max));

const hardwareSchema = z.object({
  kind: z.enum(["dgx-spark", "other"]),
  product: text(128).nullish(),
  vendor: text(128).nullish(),
  gpus: z.array(text(128)).max(MAX_GPUS),
  memoryMb: z.number().int().min(0).max(16_777_216),
  cpuArch: text(32),
  cpuCores: z.number().int().min(0).max(4096),
});

/** Self-reported by the agent; never an input to billing or authorization. */
export type GatewayHardware = z.infer<typeof hardwareSchema>;

const hardwareListSchema = z.array(hardwareSchema).max(MAX_HARDWARE_ENTRIES);

/**
 * The distinct hardware a deployment reports, or an empty list when the field
 * is absent. A malformed value is logged and dropped, so one bad agent cannot
 * stop the inventory from syncing.
 */
export function parseGatewayHardware(
  value: unknown,
  model: string,
): GatewayHardware[] {
  if (value === undefined || value === null) return [];
  const parsed = hardwareListSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.warn(
    { model, issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
    "[res] gateway hardware is malformed and was dropped",
  );
  return [];
}

/** The hardware behind each resource linked to an active gateway model. */
export async function listHardwareForResources(
  resourceIds: readonly string[],
): Promise<Map<string, GatewayHardware[]>> {
  const hardware = new Map<string, GatewayHardware[]>();
  if (resourceIds.length === 0) return hardware;
  const rows = await db
    .select({
      resourceId: resourceGatewayLinks.resourceId,
      objectName: gatewayObjects.objectName,
      metadata: gatewayObjects.metadata,
    })
    .from(resourceGatewayLinks)
    .innerJoin(
      gatewayObjects,
      eq(resourceGatewayLinks.gatewayObjectId, gatewayObjects.id),
    )
    .where(
      and(
        inArray(resourceGatewayLinks.resourceId, [...resourceIds]),
        eq(gatewayObjects.isActive, true),
      ),
    );
  for (const row of rows) {
    const entries = parseGatewayHardware(row.metadata.hardware, row.objectName);
    if (entries.length > 0) hardware.set(row.resourceId, entries);
  }
  return hardware;
}
