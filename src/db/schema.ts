import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  numeric,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// ── Applications ──────────────────────────────────────────────────────────────
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    skipConsent: boolean("skip_consent").notNull().default(false),
    isMfaRequired: boolean("is_mfa_required").notNull().default(false),
    allowRegister: boolean("allow_register").notNull().default(true),
    allowedScopes: text("allowed_scopes")
      .array()
      .notNull()
      .default(["openid", "profile", "email"]),
    redirectUris: text("redirect_uris").array().notNull().default([]),
    isPublic: boolean("is_public").notNull().default(false),
    url: text("url"),
    icon: text("icon"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("applications_slug_idx").on(t.slug)],
);

// ── User Applications ─────────────────────────────────────────────────────────
export const userApplications = pgTable(
  "user_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    isActive: boolean("is_active").notNull().default(true),
    subscriptionPlanId: uuid("subscription_plan_id").references(
      () => subscriptionPlans.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("user_applications_user_app_idx").on(t.userId, t.applicationId),
  ],
);

// ── App Roles ─────────────────────────────────────────────────────────────────
export const appRoles = pgTable(
  "app_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("app_roles_app_name_idx").on(t.applicationId, t.name)],
);

// ── App Permissions ───────────────────────────────────────────────────────────
export const appPermissions = pgTable(
  "app_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    action: text("action").notNull().default("read"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("app_permissions_app_resource_action_idx").on(
      t.applicationId,
      t.resource,
      t.action,
    ),
  ],
);

// ── App Role Permissions (join) ───────────────────────────────────────────────
export const appRolePermissions = pgTable(
  "app_role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => appRoles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => appPermissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

// ── User App Roles ────────────────────────────────────────────────────────────
export const userAppRoles = pgTable(
  "user_app_roles",
  {
    userId: text("user_id").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => appRoles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.applicationId, t.roleId] })],
);

// ── Subscription Plans ────────────────────────────────────────────────────────
export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    stripeProductId: text("stripe_product_id"),
    features: jsonb("features").notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("subscription_plans_app_name_idx").on(t.applicationId, t.name),
  ],
);

// ── Subscription Plan Prices ──────────────────────────────────────────────────
export const subscriptionPlanPrices = pgTable("subscription_plan_prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id")
    .notNull()
    .references(() => subscriptionPlans.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  amount: numeric("amount").notNull(), // in smallest currency unit (e.g. cents)
  currency: text("currency").notNull().default("usd"),
  interval: text("interval").notNull().default("month"), // "month" | "year" | "one_time"
  stripePriceId: text("stripe_price_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── User Subscriptions ────────────────────────────────────────────────────────
export const userSubscriptions = pgTable(
  "user_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("user_subscriptions_user_app_idx").on(
      t.userId,
      t.applicationId,
    ),
  ],
);

// ── Consumption Entries ───────────────────────────────────────────────────────
export const consumptionEntries = pgTable(
  "consumption_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: numeric("value").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("consumption_entries_user_app_key_idx").on(
      t.userId,
      t.applicationId,
      t.key,
    ),
  ],
);

// ── Consumption Aggregates ────────────────────────────────────────────────────
export const consumptionAggregates = pgTable(
  "consumption_aggregates",
  {
    userId: text("user_id").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    total: numeric("total").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.applicationId, t.key] })],
);
