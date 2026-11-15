import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";
import { resources } from "./resource-schema.js";

/** Target host and account for an SSH resource. Never exposed to recipients. */
export const sshResourceDetails = pgTable(
  "ssh_resource_details",
  {
    resourceId: uuid("resource_id")
      .primaryKey()
      .references(() => resources.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    account: text("account").notNull(),
    hostKeyFingerprint: text("host_key_fingerprint"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "ssh_resource_details_host_check",
      sql`length(${t.host}) BETWEEN 1 AND 255`,
    ),
    check(
      "ssh_resource_details_port_check",
      sql`${t.port} BETWEEN 1 AND 65535`,
    ),
    check(
      "ssh_resource_details_account_check",
      sql`${t.account} ~ '^[A-Za-z0-9._-]{1,64}$'`,
    ),
  ],
);

/**
 * Ed25519 identity used by the gateway to reach the target. The private key is
 * AES-256-GCM ciphertext under the gateway envelope key; auth-service never
 * decrypts it.
 */
export const sshResourceIdentities = pgTable(
  "ssh_resource_identities",
  {
    resourceId: uuid("resource_id")
      .primaryKey()
      .references(() => resources.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    privateKeyCiphertext: text("private_key_ciphertext").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ssh_resource_identities_fingerprint_idx").on(t.fingerprint),
  ],
);

/**
 * Share selector sent as the SSH username. It maps to a resource; the actual
 * subject is proven by the recipient key and the device approval, then checked
 * against the generic grants.
 */
export const sshShareDetails = pgTable(
  "ssh_share_details",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    metaUser: text("meta_user").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ssh_share_details_meta_user_idx").on(t.metaUser),
    index("ssh_share_details_resource_idx").on(t.resourceId),
    check(
      "ssh_share_details_meta_user_check",
      sql`${t.metaUser} ~ '^[a-z0-9][a-z0-9_-]{2,31}$'`,
    ),
  ],
);

/** Recipient public keys. A revoked key can be registered again. */
export const sshRecipientKeys = pgTable(
  "ssh_recipient_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ssh_recipient_keys_public_active_idx")
      .on(t.publicKey)
      .where(sql`${t.revokedAt} IS NULL`),
    uniqueIndex("ssh_recipient_keys_fingerprint_active_idx")
      .on(t.fingerprint)
      .where(sql`${t.revokedAt} IS NULL`),
    index("ssh_recipient_keys_user_idx").on(t.userId),
  ],
);

export const SSH_SESSION_END_REASONS = [
  "client",
  "idle",
  "error",
  "revoked",
  "target",
] as const;
export type SshSessionEndReason = (typeof SSH_SESSION_END_REASONS)[number];

/** Session accounting for the sales and RSSI views. */
export const sshSessions = pgTable(
  "ssh_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    bytesIn: bigint("bytes_in", { mode: "number" }),
    bytesOut: bigint("bytes_out", { mode: "number" }),
    endReason: text("end_reason").$type<SshSessionEndReason>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ssh_sessions_session_idx").on(t.sessionId),
    index("ssh_sessions_resource_idx").on(t.resourceId, t.startedAt),
    index("ssh_sessions_subject_idx").on(t.subjectId, t.startedAt),
    check(
      "ssh_sessions_end_reason_check",
      sql`${t.endReason} IN ('client', 'idle', 'error', 'revoked', 'target')`,
    ),
    check("ssh_sessions_time_check", sql`${t.endedAt} >= ${t.startedAt}`),
    check(
      "ssh_sessions_bytes_check",
      sql`(${t.bytesIn} IS NULL OR ${t.bytesIn} >= 0)
        AND (${t.bytesOut} IS NULL OR ${t.bytesOut} >= 0)`,
    ),
  ],
);
