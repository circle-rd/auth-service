import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { resources } from "./resource-schema.js";

export const GATEWAY_OBJECT_KINDS = [
  "model",
  "agent",
  "mcp_server",
  "mcp_tool",
] as const;
export type GatewayObjectKind = (typeof GATEWAY_OBJECT_KINDS)[number];

/**
 * Read-only projection of the LiteLLM inventory. It is not the ownership model:
 * resources belong to an application and may link to an inventory object.
 */
export const gatewayObjects = pgTable(
  "gateway_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<GatewayObjectKind>().notNull(),
    litellmId: text("litellm_id").notNull(),
    objectName: text("object_name").notNull(),
    parentName: text("parent_name").notNull().default(""),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gateway_objects_litellm_idx").on(t.kind, t.litellmId),
    // Only live names are unique: a provider id change retires the old row
    // before the replacement becomes active.
    uniqueIndex("gateway_objects_name_idx")
      .on(t.kind, t.objectName, t.parentName)
      .where(sql`${t.isActive} = true`),
    index("gateway_objects_active_idx").on(t.kind, t.isActive),
    check(
      "gateway_objects_kind_check",
      sql`${t.kind} IN ('model', 'agent', 'mcp_server', 'mcp_tool')`,
    ),
    check("gateway_objects_name_check", sql`length(${t.objectName}) > 0`),
    check(
      "gateway_objects_parent_check",
      sql`(${t.kind} = 'mcp_tool' AND length(${t.parentName}) > 0)
        OR (${t.kind} <> 'mcp_tool' AND ${t.parentName} = '')`,
    ),
  ],
);

/** One resource may reference one inventory object; an object may back many. */
export const resourceGatewayLinks = pgTable(
  "resource_gateway_links",
  {
    resourceId: uuid("resource_id")
      .primaryKey()
      .references(() => resources.id, { onDelete: "cascade" }),
    gatewayObjectId: uuid("gateway_object_id")
      .notNull()
      .references(() => gatewayObjects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("resource_gateway_links_object_idx").on(t.gatewayObjectId)],
);
