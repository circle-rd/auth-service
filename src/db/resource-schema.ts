import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { applications } from "./schema.js";
import type {
  ResourceAdapter,
  ResourceEventDecision,
  ResourceEventSource,
  ResourceOwnerType,
  ResourcePermission,
  ResourceSchemeOwnerType,
  ResourceSchemeSource,
  ResourceSchemeStatus,
  ResourceStatus,
  ResourceSubjectType,
  ResourceUsageSource,
} from "../services/resources/types.js";

// ── Resource Schemes ──────────────────────────────────────────────────────────
// Built-in schemes are mirrored from code for referential integrity; application
// schemes are registered by an application admin. The scheme is the public
// resource family, the adapter is the code that validates and enforces it.
export const resourceSchemes = pgTable(
  "resource_schemes",
  {
    scheme: text("scheme").primaryKey(),
    source: text("source").$type<ResourceSchemeSource>().notNull(),
    adapter: text("adapter").$type<ResourceAdapter>().notNull(),
    ownerType: text("owner_type").$type<ResourceSchemeOwnerType>().notNull(),
    ownerId: text("owner_id"),
    displayName: text("display_name").notNull(),
    description: text("description"),
    icon: text("icon"),
    status: text("status")
      .$type<ResourceSchemeStatus>()
      .notNull()
      .default("active"),
    validatorClientId: text("validator_client_id"),
    validatorUrl: text("validator_url"),
    config: jsonb("config")
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
    check(
      "resource_schemes_format_check",
      sql`${t.scheme} ~ '^[a-z][a-z0-9]{0,49}$'`,
    ),
    check(
      "resource_schemes_source_check",
      sql`${t.source} IN ('builtin', 'application')`,
    ),
    check(
      "resource_schemes_adapter_check",
      sql`${t.adapter} IN ('litellm', 'ssh', 'http', 'file', 'external')`,
    ),
    check(
      "resource_schemes_owner_check",
      sql`(${t.ownerType} = 'platform' AND ${t.ownerId} IS NULL)
        OR (${t.ownerType} = 'application' AND ${t.ownerId} IS NOT NULL)`,
    ),
    check(
      "resource_schemes_status_check",
      sql`${t.status} IN ('active', 'disabled')`,
    ),
    check(
      "resource_schemes_application_adapter_check",
      sql`${t.source} <> 'application' OR ${t.adapter} = 'external'`,
    ),
  ],
);

// ── Application Scheme Activation ─────────────────────────────────────────────
// A resource application opts into a built-in scheme, or owns an application
// scheme. Disabling the row removes the scheme from the catalogue without
// deleting existing resources.
export const applicationSchemes = pgTable(
  "application_schemes",
  {
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    scheme: text("scheme")
      .notNull()
      .references(() => resourceSchemes.scheme, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.scheme] }),
    index("application_schemes_scheme_idx").on(t.scheme),
  ],
);

// ── Resources ─────────────────────────────────────────────────────────────────
// `application_id` is the resource application: the tenant whose members can
// access the resource. `owner_type/owner_id` is the share authority and is
// independent from the resource application. `uri` is the canonical identity;
// ownership is never inferred from it.
export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    scheme: text("scheme")
      .notNull()
      .references(() => resourceSchemes.scheme, { onDelete: "restrict" }),
    locator: text("locator").notNull(),
    uri: text("uri").notNull(),
    displayName: text("display_name").notNull(),
    ownerType: text("owner_type").$type<ResourceOwnerType>().notNull(),
    ownerId: text("owner_id").notNull(),
    status: text("status")
      .$type<ResourceStatus>()
      .notNull()
      .default("pending_validation"),
    listed: boolean("listed").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    validationRequestedAt: timestamp("validation_requested_at", {
      withTimezone: true,
    }),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    validationError: text("validation_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("resources_uri_idx").on(t.uri),
    uniqueIndex("resources_scheme_locator_idx").on(t.scheme, t.locator),
    index("resources_application_status_idx").on(t.applicationId, t.status),
    index("resources_owner_idx").on(t.ownerType, t.ownerId),
    index("resources_scheme_status_idx").on(t.scheme, t.status),
    check(
      "resources_scheme_format_check",
      sql`${t.scheme} ~ '^[a-z][a-z0-9]{0,49}$'`,
    ),
    check(
      "resources_uri_length_check",
      sql`length(${t.uri}) BETWEEN 3 AND 512`,
    ),
    check(
      "resources_locator_length_check",
      sql`length(${t.locator}) BETWEEN 1 AND 255`,
    ),
    check(
      "resources_owner_type_check",
      sql`${t.ownerType} IN ('user', 'application')`,
    ),
    check(
      "resources_status_check",
      sql`${t.status} IN ('pending_validation', 'validation_failed', 'validated', 'disabled')`,
    ),
    check("resources_owner_id_check", sql`length(${t.ownerId}) > 0`),
  ],
);

// ── Resource Grants ───────────────────────────────────────────────────────────
// A grant is resource-scoped and never bypasses membership in the resource
// application. `subject_id` is null only for `everyone`; user, organisation and
// plan ids are opaque because the subject tables live outside this domain, and
// an `application` grant names the application client id (its immutable slug).
export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<ResourceSubjectType>().notNull(),
    subjectId: text("subject_id"),
    permission: text("permission")
      .$type<ResourcePermission>()
      .notNull()
      .default("read"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("resource_grants_resource_idx").on(t.resourceId),
    index("resource_grants_subject_idx").on(t.subjectType, t.subjectId),
    check(
      "resource_grants_subject_type_check",
      sql`${t.subjectType} IN ('user', 'organization', 'plan', 'everyone', 'application')`,
    ),
    check(
      "resource_grants_subject_id_check",
      sql`(${t.subjectType} = 'everyone' AND ${t.subjectId} IS NULL)
        OR (${t.subjectType} <> 'everyone' AND ${t.subjectId} IS NOT NULL)`,
    ),
    check(
      "resource_grants_permission_check",
      sql`${t.permission} IN ('read', 'write')`,
    ),
    check("resource_grants_created_by_check", sql`length(${t.createdBy}) > 0`),
  ],
);

// ── Resource Invitations ──────────────────────────────────────────────────────
// Email-bound redemption for a recipient who is not yet an active member. Only
// the SHA-256 hash of the token is stored. Acceptance creates the user grant in
// the same transaction as the claim.
export const resourceInvitations = pgTable(
  "resource_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    permission: text("permission")
      .$type<ResourcePermission>()
      .notNull()
      .default("read"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("resource_invitations_token_hash_idx").on(t.tokenHash),
    index("resource_invitations_email_idx").on(t.email),
    index("resource_invitations_resource_idx").on(t.resourceId),
    check(
      "resource_invitations_permission_check",
      sql`${t.permission} IN ('read', 'write')`,
    ),
    check(
      "resource_invitations_created_by_check",
      sql`length(${t.createdBy}) > 0`,
    ),
  ],
);

// ── Resource Access Events ────────────────────────────────────────────────────
// Append-only decision log for the RSSI view. No secret, content or raw IP is
// stored. `resource_id` is nullable so a denial for an unknown URI can still be
// counted without disclosing whether the resource exists.
export const resourceAccessEvents = pgTable(
  "resource_access_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resourceId: uuid("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    uri: text("uri").notNull(),
    scheme: text("scheme").notNull(),
    ownerType: text("owner_type").$type<ResourceOwnerType>(),
    ownerId: text("owner_id"),
    subjectType: text("subject_type").$type<ResourceSubjectType>(),
    subjectId: text("subject_id"),
    actorUserId: text("actor_user_id"),
    clientId: text("client_id").notNull(),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    decision: text("decision").$type<ResourceEventDecision>().notNull(),
    reasonClass: text("reason_class"),
    requestId: text("request_id"),
    source: text("source").$type<ResourceEventSource>().notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("resource_access_events_occurred_idx").on(t.occurredAt),
    index("resource_access_events_resource_idx").on(t.resourceId, t.occurredAt),
    index("resource_access_events_subject_idx").on(t.subjectId, t.occurredAt),
    index("resource_access_events_owner_idx").on(
      t.ownerType,
      t.ownerId,
      t.occurredAt,
    ),
    index("resource_access_events_application_idx").on(
      t.applicationId,
      t.occurredAt,
    ),
    check(
      "resource_access_events_decision_check",
      sql`${t.decision} IN ('allow', 'deny')`,
    ),
    check(
      "resource_access_events_source_check",
      sql`${t.source} IN ('gateway', 'ssh', 'external', 'api')`,
    ),
  ],
);

// ── Resource Usage Records ────────────────────────────────────────────────────
// Gross provider usage for the sales view, separate from the wallet ledger.
// `(resource_id, request_id)` is the idempotency boundary.
export const resourceUsageRecords = pgTable(
  "resource_usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // The usage ledger outlives the resource: deleting an application must not
    // erase historical sales data.
    resourceId: uuid("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    uri: text("uri").notNull(),
    scheme: text("scheme").notNull(),
    ownerType: text("owner_type").$type<ResourceOwnerType>().notNull(),
    ownerId: text("owner_id").notNull(),
    subjectType: text("subject_type").$type<ResourceSubjectType>(),
    subjectId: text("subject_id"),
    clientId: text("client_id").notNull(),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    requestId: text("request_id").notNull(),
    promptTokens: bigint("prompt_tokens", { mode: "number" }),
    completionTokens: bigint("completion_tokens", { mode: "number" }),
    totalTokens: bigint("total_tokens", { mode: "number" }),
    costUsd: numeric("cost_usd"),
    usageSource: text("usage_source").$type<ResourceUsageSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("resource_usage_records_event_idx").on(
      t.resourceId,
      t.requestId,
    ),
    index("resource_usage_records_owner_occurred_idx").on(
      t.ownerType,
      t.ownerId,
      t.occurredAt,
    ),
    index("resource_usage_records_application_occurred_idx").on(
      t.applicationId,
      t.occurredAt,
    ),
    index("resource_usage_records_subject_occurred_idx").on(
      t.subjectId,
      t.occurredAt,
    ),
    check(
      "resource_usage_records_source_check",
      sql`${t.usageSource} IN ('provider', 'unsupported')`,
    ),
    check(
      "resource_usage_records_tokens_check",
      sql`(${t.promptTokens} IS NULL OR ${t.promptTokens} >= 0)
        AND (${t.completionTokens} IS NULL OR ${t.completionTokens} >= 0)
        AND (${t.totalTokens} IS NULL OR ${t.totalTokens} >= 0)`,
    ),
    check(
      "resource_usage_records_cost_check",
      sql`${t.costUsd} IS NULL OR ${t.costUsd} >= 0`,
    ),
    check(
      "resource_usage_records_unsupported_check",
      sql`${t.usageSource} <> 'unsupported' OR (
        ${t.costUsd} IS NULL
        AND ${t.promptTokens} IS NULL
        AND ${t.completionTokens} IS NULL
        AND ${t.totalTokens} IS NULL
      )`,
    ),
  ],
);

// ── Resource Webhook Deliveries ───────────────────────────────────────────────
// Durable outbox for application callbacks. A row is claimed atomically before
// the HTTP POST so replicas do not send the same event twice; the payload is
// stored as delivered so a retry after a restart keeps the same event id.
export const resourceWebhookDeliveries = pgTable(
  "resource_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status")
      .$type<"pending" | "delivered" | "failed">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("resource_webhook_deliveries_event_idx").on(
      t.applicationId,
      t.eventId,
    ),
    index("resource_webhook_deliveries_pending_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    check(
      "resource_webhook_deliveries_status_check",
      sql`${t.status} IN ('pending', 'delivered', 'failed')`,
    ),
  ],
);
