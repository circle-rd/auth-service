import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema.js";
import { applications } from "./schema.js";

export const personalGatewayKeys = pgTable(
  "personal_gateway_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    // null = whole network. Cascade: a deleted organization invalidates its keys.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    label: text("label").notNull(),
    keyHash: text("key_hash").notNull(),
    maskedKey: text("masked_key").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("personal_gateway_keys_hash_idx").on(t.keyHash),
    index("personal_gateway_keys_user_idx").on(t.userId),
    check(
      "personal_gateway_keys_label_check",
      sql`length(${t.label}) BETWEEN 1 AND 80`,
    ),
    check("personal_gateway_keys_hash_check", sql`length(${t.keyHash}) = 43`),
  ],
);
