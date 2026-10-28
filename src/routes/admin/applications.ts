import type { FastifyInstance, FastifyRequest } from "fastify";
import { generateId } from "better-auth";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  appRoles,
  userApplications,
  userAppRoles,
  consumptionAggregates,
  consumptionEntries,
  subscriptionPlans,
  userSubscriptions,
  loginHistory,
} from "../../db/schema.js";
import { assignDefaultRoleIfNeeded } from "../../services/claims.js";
import {
  assertPlanBelongsToApp,
  assignDefaultPlanIfNeeded,
  getCurrentSubscriptionPlanId,
  setUserSubscription,
} from "../../services/subscriptions.js";
import {
  archiveApplicationCatalogue,
  loadApplicationCatalogue,
  provisionPlanProductBestEffort,
  updateApplicationProducts,
} from "../../services/billing/catalog.js";
import {
  assignRequestedOrDefaultPlan,
  planChangeReasonRequired,
  subscriptionReasonSchema,
} from "./subscription-request.js";
import {
  oauthClient,
  member,
  user as userTable,
} from "../../db/auth-schema.js";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { ERR } from "../../errors.js";
import { clientSecretAuthMethod } from "../../compat/token-auth.js";
import { randomBytes, createHash } from "node:crypto";
import { addCorsOrigin, removeCorsOrigin } from "../../runtime-config.js";
import {
  assertAllowedResources,
  replaceClientResource,
  deleteClientResource,
} from "../../services/oauth-resources.js";
import {
  revokeUserClientTokens,
  revokeClientTokens,
} from "../../services/oauth-tokens.js";
import {
  getActorUserId,
  getRequestSession,
  requireAdmin,
} from "../../middleware.js";
import {
  assertPublicBackchannelLogoutUri,
  backchannelLogoutUriSchema,
} from "../../services/backchannel-logout-uri.js";
import { publishEvent } from "../../services/event-bus.js";
import {
  ensureTeamBeforeSave,
  retireTeamAfterSave,
} from "../../services/litellm-sync.js";
import { DEFAULT_PLAN_NAME } from "../../services/litellm-plan.js";

/** Hash a plaintext client secret using SHA-256 base64url (matches BetterAuth's defaultHasher). */
function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest().toString("base64url");
}

/**
 * `enableEndSession`, `postLogoutRedirectUris` and the back-channel logout
 * settings live on the BetterAuth `oauth_client` table, not on `applications`.
 * The admin UI needs them in every payload that exposes an application, so we
 * fetch them by `clientId` (= application slug) and merge them into the
 * response.
 */
interface OauthClientView {
  enableEndSession: boolean;
  postLogoutRedirectUris: string[];
  /** OIDC Back-Channel Logout endpoint, or null when the app does not support it. */
  backchannelLogoutUri: string | null;
  backchannelLogoutSessionRequired: boolean;
}

/**
 * The single source of truth for the logout-related column selection, so the
 * read path and the write path cannot drift. Reused by every select below.
 */
const oauthClientViewFields = {
  enableEndSession: oauthClient.enableEndSession,
  postLogoutRedirectUris: oauthClient.postLogoutRedirectUris,
  backchannelLogoutUri: oauthClient.backchannelLogoutUri,
  backchannelLogoutSessionRequired:
    oauthClient.backchannelLogoutSessionRequired,
} as const;

/**
 * Normalise a possibly-missing row into the shape the API promises. The
 * defaults live here once: a historical row may have `enable_end_session =
 * NULL`, and absence is treated as "feature off" rather than silently exposed.
 */
function toOauthClientView(
  row:
    | {
        enableEndSession: boolean | null;
        postLogoutRedirectUris: string[] | null;
        backchannelLogoutUri: string | null;
        backchannelLogoutSessionRequired: boolean | null;
      }
    | undefined,
): OauthClientView {
  return {
    enableEndSession: row?.enableEndSession ?? false,
    postLogoutRedirectUris: row?.postLogoutRedirectUris ?? [],
    backchannelLogoutUri: row?.backchannelLogoutUri ?? null,
    backchannelLogoutSessionRequired:
      row?.backchannelLogoutSessionRequired ?? false,
  };
}

async function fetchOauthClientView(slug: string): Promise<OauthClientView> {
  const [row] = await db
    .select(oauthClientViewFields)
    .from(oauthClient)
    .where(eq(oauthClient.clientId, slug))
    .limit(1);
  return toOauthClientView(row);
}

async function fetchOauthClientViews(
  slugs: string[],
): Promise<Map<string, OauthClientView>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ clientId: oauthClient.clientId, ...oauthClientViewFields })
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, slugs));
  return new Map(rows.map((r) => [r.clientId, toOauthClientView(r)]));
}

/**
 * Columns an application create/update writes to the `oauth_client` row for the
 * back-channel logout feature. Defined once so the insert and the response
 * cannot disagree on the null/false sentinels.
 */
function backchannelLogoutValues(data: {
  backchannelLogoutUri?: string | null;
  backchannelLogoutSessionRequired?: boolean;
}) {
  return {
    backchannelLogoutUri: data.backchannelLogoutUri ?? null,
    backchannelLogoutSessionRequired:
      data.backchannelLogoutSessionRequired ?? false,
  };
}

function mergeOauthView<T extends { slug: string }>(
  app: T,
  view: OauthClientView,
): T & OauthClientView {
  return { ...app, ...view };
}

/**
 * Compute the effective `postLogoutRedirectUris` whitelist at create time.
 * If the operator did not provide any but supplied a `url`, seed it with the
 * canonical root URL (`${url}/`). This matches the most common SPA pattern
 * (BFF redirects the browser back to the app root after logout) and avoids a
 * silent post-logout failure where AuthService destroys the SSO session but
 * fails to redirect because no entry matches.
 */
function effectivePostLogoutRedirectUris(
  postLogoutRedirectUris: string[],
  url: string | null | undefined,
): string[] {
  if (postLogoutRedirectUris.length > 0) return postLogoutRedirectUris;
  if (!url) return [];
  const root = url.replace(/\/?$/, "/");
  return [root];
}

/**
 * Reserved JWT claim names that MUST NOT be overridden via per-application
 * metadata. These are managed by the OAuth provider itself.
 */
const RESERVED_JWT_CLAIMS = new Set([
  "sub",
  "aud",
  "iss",
  "exp",
  "iat",
  "nbf",
  "jti",
  "scope",
  "scopes",
  "azp",
  "client_id",
  "token_type",
  "auth_time",
  "acr",
  "amr",
]);

/**
 * Zod schema for the `metadata` field on applications. Values are restricted
 * to strings because they are surfaced to resource servers via the JWT
 * `client_attrs` field, whose contract requires string-typed entries (see
 * EMQX 5 JWT authn / client attributes spec). Keep keys to safe identifiers.
 */
const metadataSchema = z
  .record(z.string(), z.string().max(256))
  .refine((m) => Object.keys(m).every((k) => !RESERVED_JWT_CLAIMS.has(k)), {
    message: "metadata keys must not collide with reserved JWT claims",
  })
  .refine(
    (m) => Object.keys(m).every((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)),
    {
      message:
        "metadata keys must be valid identifiers (letters, digits, underscore)",
    },
  );

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Ensure a role belongs to the given application before it is assigned to a
 * user. Without this check an admin could attach a `roleId` from a different
 * application (the `userAppRoles` insert does not constrain the role's owning
 * app), leaking that app's role name / permissions into the target app's
 * tokens via `getUserClaims`. Throws APP_001 on mismatch or unknown role.
 */
async function assertRoleBelongsToApp(
  roleId: string,
  applicationId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: appRoles.id })
    .from(appRoles)
    .where(
      and(eq(appRoles.id, roleId), eq(appRoles.applicationId, applicationId)),
    )
    .limit(1);
  if (!row) {
    throw ERR.APP_001("Role does not belong to this application");
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const allowedResourcesSchema = z
  .array(z.string().url())
  .transform((list) => [...new Set(list)]);

// Only providers the service actually registers with BetterAuth can be
// assigned; a button for an unwired provider would fail at sign-in.
const socialProviderSchema = z.enum(["google", "github"]);

const createAppSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(false),
  isSystem: z.boolean().default(false),
  skipConsent: z.boolean().default(false),
  isMfaRequired: z.boolean().default(false),
  allowRegister: z.boolean().default(false),
  billingMode: z.enum(["none", "delegated"]).default("none"),
  allowedScopes: z.array(z.string()).default(["openid", "profile", "email"]),
  redirectUris: z.array(z.string().url()).default([]),
  // OIDC RP-Initiated Logout 1.0. When true, the client may call
  // /oauth2/end-session, which ends the SSO session for ALL apps (no per-app
  // variant) and puts `sid` in the client's ID tokens. Off by default: apps that
  // only log out locally leave it off.
  enableEndSession: z.boolean().default(false),
  // Whitelist of URLs that may be passed as `post_logout_redirect_uri` to
  // the end-session endpoint. Empty array = no post-logout redirect allowed.
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  // OIDC Back-Channel Logout 1.0. When set, ending a session POSTs a signed
  // logout token to this endpoint so the application can drop its local
  // session. null = the application does not support back-channel logout.
  backchannelLogoutUri: backchannelLogoutUriSchema.nullable().optional(),
  // Declares that the application requires `sid` in every logout token (the
  // provider always sends it) and ends only the session `sid` names (spec §2.8).
  backchannelLogoutSessionRequired: z.boolean().default(false),
  url: z.string().url().optional().nullable(),
  // Protected resources (other applications' URLs, e.g. the LiteLLM gateway)
  // this application may request access tokens for (RFC 8707 `resource`).
  allowedResources: allowedResourcesSchema.default([]),
  icon: z.string().optional().nullable(),
  enabledSocialProviders: z.array(socialProviderSchema).nullable().optional(),
  metadata: metadataSchema.optional().default({}),
});

// Fields that carry a create-time default must be re-declared `.optional()`:
// Zod's `.partial()` keeps a field's `.default()`, so a partial update that
// omits one would otherwise parse to the default and silently reset the stored
// value (e.g. a PATCH that only renames an application turning off
// `allowRegister`, `enableEndSession` or `backchannelLogoutSessionRequired`).
const updateAppSchema = createAppSchema
  .partial()
  .omit({ slug: true, isPublic: true })
  .extend({
    isActive: z.boolean().optional(),
    isSystem: z.boolean().optional(),
    skipConsent: z.boolean().optional(),
    isMfaRequired: z.boolean().optional(),
    allowRegister: z.boolean().optional(),
    billingMode: z.enum(["none", "delegated"]).optional(),
    allowedScopes: z.array(z.string()).optional(),
    redirectUris: z.array(z.string().url()).optional(),
    enableEndSession: z.boolean().optional(),
    postLogoutRedirectUris: z.array(z.string().url()).optional(),
    backchannelLogoutSessionRequired: z.boolean().optional(),
    allowedResources: allowedResourcesSchema.optional(),
    metadata: metadataSchema.optional(),
  });

const grantUserAccessSchema = z.object({
  userId: z.string().min(1),
  roleId: z.string().uuid().optional(),
  // When omitted the application's default plan is assigned instead.
  subscriptionPlanId: z.string().uuid().optional(),
  reason: subscriptionReasonSchema.optional(),
});

const bulkGrantUserAccessSchema = z
  .object({
    // Either every member of an organization…
    organizationId: z.string().min(1).optional(),
    // …or an explicit list of user ids.
    userIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
    roleId: z.string().uuid().optional(),
    // Applied to every granted user; the app default plan is used when omitted.
    subscriptionPlanId: z.string().uuid().optional(),
    reason: subscriptionReasonSchema.optional(),
  })
  .refine((d) => Boolean(d.organizationId) !== Boolean(d.userIds), {
    message: "Provide exactly one of organizationId or userIds",
  });

const updateUserAccessSchema = z
  .object({
    isActive: z.boolean().optional(),
    roleId: z.string().uuid().optional().nullable(),
    subscriptionPlanId: z.string().uuid().optional().nullable(),
    expiresAt: z.string().datetime().optional().nullable(),
    // A manual plan change is audited, so it must carry a reason.
    reason: subscriptionReasonSchema.optional(),
  })
  .refine((d) => !planChangeReasonRequired(d), {
    message: "reason is required when changing the subscription plan",
    path: ["reason"],
  });

/** Hiding an application and protecting it from deletion is a superadmin decision. */
async function assertMaySetSystemFlag(req: FastifyRequest): Promise<void> {
  const session = await getRequestSession(req);
  if (!session) throw ERR.AUTH_001();
  if ((session.user as Record<string, unknown>).role !== "superadmin") {
    throw ERR.AUTH_011("Only superadmins can change the system flag");
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function applicationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/applications
  fastify.get("/", async (_req, reply) => {
    const rows = await db
      .select()
      .from(applications)
      .orderBy(applications.createdAt);
    const views = await fetchOauthClientViews(rows.map((r) => r.slug));
    const enriched = rows.map((r) =>
      mergeOauthView(r, views.get(r.slug) ?? toOauthClientView(undefined)),
    );
    await reply.send({ applications: enriched });
  });

  // POST /api/admin/applications
  fastify.post("/", async (req, reply) => {
    const parsed = createAppSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ERR.APP_001("Invalid application data", parsed.error.flatten());
    }
    const data = parsed.data;
    if (data.isSystem) await assertMaySetSystemFlag(req);

    // The creator is resolved from its session, never from the request body.
    // `requireAdmin` runs as a preHandler and proves the session exists, so the
    // creator is known before the application is written. Resolving it here
    // keeps the bootstrap below outside the creation transaction.
    const creatorSession = await getRequestSession(req);
    if (!creatorSession) throw ERR.AUTH_001();
    const creatorId = creatorSession.user.id;

    // Check slug uniqueness (slug is used as the OAuth clientId)
    const [existing] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, data.slug))
      .limit(1);
    if (existing) throw ERR.APP_003();

    await assertAllowedResources(data.allowedResources, data.url ?? null);
    if (data.backchannelLogoutUri) {
      await assertPublicBackchannelLogoutUri(data.backchannelLogoutUri);
    }
    // The plans do not exist yet (a new application is created with just its
    // default one), so the team ids are derived from the plan names here.
    await ensureTeamBeforeSave(data, [], [DEFAULT_PLAN_NAME]);

    // Generate and hash the client secret (only for confidential clients)
    const rawSecret = data.isPublic ? null : randomBytes(32).toString("hex");
    const hashedSecret = rawSecret ? hashClientSecret(rawSecret) : null;

    // Transactionally create the application row and the corresponding oauthClient row
    const [app] = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(applications)
        .values({
          name: data.name,
          slug: data.slug,
          description: data.description,
          isActive: data.isActive,
          isPublic: data.isPublic,
          isSystem: data.isSystem,
          skipConsent: data.skipConsent,
          isMfaRequired: data.isMfaRequired,
          allowRegister: data.allowRegister,
          billingMode: data.billingMode,
          allowedScopes: data.allowedScopes,
          redirectUris: data.redirectUris,
          url: data.url,
          allowedResources: data.allowedResources,
          icon: data.icon,
          enabledSocialProviders: data.enabledSocialProviders ?? null,
          metadata: data.metadata ?? {},
        })
        .returning();

      const app = rows[0]!;

      // Insert into BetterAuth's oauthClient table.
      // slug is used as clientId so external apps can reference it by name.
      // metadata.clientId is read by customIdTokenClaims to resolve claims.
      await tx.insert(oauthClient).values({
        id: generateId(),
        clientId: data.slug,
        clientSecret: hashedSecret,
        name: data.name,
        skipConsent: data.skipConsent,
        scopes: data.allowedScopes,
        redirectUris: data.redirectUris,
        enableEndSession: data.enableEndSession,
        // Keep the OAuth client's enabled state in sync with the application
        // so a disabled app cannot obtain tokens.
        disabled: !data.isActive,
        postLogoutRedirectUris: effectivePostLogoutRedirectUris(
          data.postLogoutRedirectUris,
          data.url,
        ),
        ...backchannelLogoutValues(data),
        // OAuth 2.1 client metadata. Web clients that hold a secret use
        // client_secret_basic and may use the client_credentials grant; public
        // clients (SPAs) use `none` and are limited to the authorization code
        // flow. PKCE is required for every client.
        applicationType: "web",
        tokenEndpointAuthMethod: data.isPublic
          ? "none"
          : clientSecretAuthMethod(data.isSystem),
        grantTypes: data.isPublic
          ? ["authorization_code", "refresh_token"]
          : ["authorization_code", "refresh_token", "client_credentials"],
        responseTypes: ["code"],
        requirePKCE: true,
        // Machine-to-machine scope. Deliberately separate from the app's OIDC
        // `allowedScopes` (openid/profile/email are user-delegated and rejected
        // by the client_credentials grant). Public clients cannot use M2M.
        clientCredentialsScopes: data.isPublic ? [] : ["m2m"],
        metadata: { clientId: data.slug, applicationId: app.id },
      });

      return rows;
    });

    // ── Bootstrap macros ────────────────────────────────────────────────────
    // Run outside the main transaction so that failures here don't roll back
    // the application/oauthClient creation.

    // a) Create predefined roles: "user" (default) and "admin"
    const [userRole, adminRole] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(appRoles)
        .values([
          { applicationId: app!.id, name: "user", isDefault: true },
          { applicationId: app!.id, name: "admin", isDefault: false },
        ])
        .returning();
      return inserted;
    });

    // b) Create default "free" subscription plan
    const [freePlan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app!.id,
        name: DEFAULT_PLAN_NAME,
        isDefault: true,
        features: {},
      })
      .returning();

    // b2) Give the default plan its Stripe Product too. Best-effort: a Stripe
    // incident must not fail the application creation (reconciliation fills it).
    if (freePlan) {
      await provisionPlanProductBestEffort({
        planId: freePlan.id,
        applicationId: app!.id,
        appName: app!.name,
        planName: freePlan.name,
        description: freePlan.description,
      });
    }

    // c) Assign every existing superadmin — and the caller who just created the
    // application — to the app with the "admin" role and the "free" plan.
    if (adminRole && freePlan) {
      const superadmins = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.role, "superadmin"));

      // A superadmin creator is already listed by the query above, so the Set
      // also guarantees it is never written twice.
      const recipients = new Set(superadmins.map((sa) => sa.id));
      recipients.add(creatorId);

      for (const userId of recipients) {
        // Grant access (upsert in case of edge-case duplicate)
        await db
          .insert(userApplications)
          .values({
            userId,
            applicationId: app!.id,
            isActive: true,
            subscriptionPlanId: freePlan.id,
          })
          .onConflictDoUpdate({
            target: [userApplications.userId, userApplications.applicationId],
            set: { isActive: true, subscriptionPlanId: freePlan.id },
          });

        // Assign the "admin" role (not the default "user" role)
        await db
          .insert(userAppRoles)
          .values({
            userId,
            applicationId: app!.id,
            roleId: adminRole.id,
          })
          .onConflictDoNothing();

        // Assign the "free" subscription
        await db
          .insert(userSubscriptions)
          .values({
            userId,
            applicationId: app!.id,
            planId: freePlan.id,
            isActive: true,
          })
          .onConflictDoNothing();
      }
    }

    // Suppress unused variable warning for userRole (returned for completeness)
    void userRole;

    const response: Record<string, unknown> = {
      application: mergeOauthView(app!, {
        enableEndSession: data.enableEndSession,
        postLogoutRedirectUris: effectivePostLogoutRedirectUris(
          data.postLogoutRedirectUris,
          data.url,
        ),
        ...backchannelLogoutValues(data),
      }),
      clientId: data.slug,
    };
    // Secret shown once — not persisted in plaintext. Public clients have no secret.
    if (rawSecret) response.clientSecret = rawSecret;

    // Register the app URL as a protected OAuth resource (RFC 8707) and CORS
    // origin immediately. Takes effect on the next request — no restart needed.
    if (data.url) {
      addCorsOrigin(data.url);
    }
    await replaceClientResource({
      clientId: data.slug,
      identifier: data.url ?? null,
      name: data.name,
      allowedResources: data.allowedResources,
    });

    // Announced last: the row and every bootstrap write above are committed by
    // now, so a client that reacts by re-reading sees the finished application.
    publishEvent("application.changed");

    await reply.status(201).send(response);
  });

  // GET /api/admin/applications/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!app) throw ERR.APP_002();
    const view = await fetchOauthClientView(app.slug);
    await reply.send({ application: mergeOauthView(app, view) });
  });

  // PATCH /api/admin/applications/:id
  fastify.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = updateAppSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid data", parsed.error.flatten());
    if (parsed.data.isSystem !== undefined) await assertMaySetSystemFlag(req);
    if (parsed.data.backchannelLogoutUri) {
      await assertPublicBackchannelLogoutUri(parsed.data.backchannelLogoutUri);
    }

    // Fetch the current URL before applying the update so we can diff it.
    const [before] = await db
      .select({
        url: applications.url,
        slug: applications.slug,
        name: applications.name,
        allowedResources: applications.allowedResources,
      })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!before) throw ERR.APP_002();

    // Re-validated on every update so a resource that disappeared since the
    // last save is reported instead of failing on the link insert.
    await assertAllowedResources(
      parsed.data.allowedResources ?? before.allowedResources,
      parsed.data.url !== undefined ? parsed.data.url : before.url,
    );

    // The gateway team must exist before an application gets LiteLLM support.
    await ensureTeamBeforeSave(
      {
        slug: before.slug,
        name: parsed.data.name ?? before.name,
        allowedResources:
          parsed.data.allowedResources ?? before.allowedResources,
      },
      before.allowedResources,
    );

    // `enableEndSession`, `postLogoutRedirectUris` and the back-channel logout
    // settings live exclusively on the BetterAuth `oauthClient` row, not on
    // `applications` — strip them before updating the application table.
    const {
      enableEndSession: _ees,
      postLogoutRedirectUris: _plru,
      backchannelLogoutUri: _bclu,
      backchannelLogoutSessionRequired: _bclsr,
      ...applicationData
    } = parsed.data;
    void _ees;
    void _plru;
    void _bclu;
    void _bclsr;

    const [app] = await db
      .update(applications)
      .set({ ...applicationData, updatedAt: new Date() })
      .where(eq(applications.id, req.params.id))
      .returning();
    if (!app) throw ERR.APP_002();

    // Sync CORS origin + protected resource when the URL field changes.
    // The OAuth resource link is refreshed unconditionally below.
    if (parsed.data.url !== undefined && parsed.data.url !== before.url) {
      if (before.url) {
        removeCorsOrigin(before.url);
      }
      if (parsed.data.url) {
        addCorsOrigin(parsed.data.url);
      }
    }

    // Sync relevant fields to the BetterAuth oauthClient table
    const oauthUpdate: Partial<typeof oauthClient.$inferInsert> = {};
    if (parsed.data.name !== undefined) oauthUpdate.name = parsed.data.name;
    if (parsed.data.allowedScopes !== undefined)
      oauthUpdate.scopes = parsed.data.allowedScopes;
    if (parsed.data.skipConsent !== undefined)
      oauthUpdate.skipConsent = parsed.data.skipConsent;
    if (parsed.data.redirectUris !== undefined)
      oauthUpdate.redirectUris = parsed.data.redirectUris;
    // Mirror the application's active flag onto the OAuth client so a disabled
    // application stops issuing tokens.
    if (parsed.data.isActive !== undefined)
      oauthUpdate.disabled = !parsed.data.isActive;
    if (parsed.data.enableEndSession !== undefined)
      oauthUpdate.enableEndSession = parsed.data.enableEndSession;
    if (parsed.data.postLogoutRedirectUris !== undefined)
      oauthUpdate.postLogoutRedirectUris = parsed.data.postLogoutRedirectUris;
    if (parsed.data.backchannelLogoutUri !== undefined)
      oauthUpdate.backchannelLogoutUri = parsed.data.backchannelLogoutUri;
    if (parsed.data.backchannelLogoutSessionRequired !== undefined)
      oauthUpdate.backchannelLogoutSessionRequired =
        parsed.data.backchannelLogoutSessionRequired;

    if (Object.keys(oauthUpdate).length > 0) {
      await db
        .update(oauthClient)
        .set(oauthUpdate)
        .where(eq(oauthClient.clientId, app.slug));
    }

    // Keep the RFC 8707 resource identifier and client link aligned with the
    // (possibly changed) application URL.
    await replaceClientResource({
      clientId: app.slug,
      identifier: app.url,
      name: app.name,
      allowedResources: app.allowedResources,
    });

    // Keep the Stripe Products named after the (possibly renamed) application.
    if (parsed.data.name !== undefined && parsed.data.name !== before.name) {
      await updateApplicationProducts({
        applicationId: app.id,
        appName: app.name,
      });
    }

    await retireTeamAfterSave(
      app.slug,
      before.allowedResources,
      app.allowedResources,
    );

    const view = await fetchOauthClientView(app.slug);
    publishEvent("application.changed");
    await reply.send({ application: mergeOauthView(app, view) });
  });

  // DELETE /api/admin/applications/:id
  // All related rows (roles, plans, user_applications, etc.) are cascade-deleted via FK constraints.
  fastify.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [existing] = await db
      .select({
        isSystem: applications.isSystem,
        allowedResources: applications.allowedResources,
      })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!existing) throw ERR.APP_002();
    if (existing.isSystem) throw ERR.APP_007();

    // Read the catalogue before the application's rows cascade away, so its
    // Stripe objects can be archived (never deleted) afterwards.
    const catalogue = await loadApplicationCatalogue(req.params.id);

    const [deleted] = await db
      .delete(applications)
      .where(eq(applications.id, req.params.id))
      .returning({
        id: applications.id,
        slug: applications.slug,
        url: applications.url,
      });
    if (!deleted) throw ERR.APP_002();

    // Remove the oauthClient row (cascades to tokens/consents in BetterAuth tables)
    await db.delete(oauthClient).where(eq(oauthClient.clientId, deleted.slug));

    // Drop the client's protected-resource links.
    await deleteClientResource(deleted.slug);

    // Remove the URL from runtime-config.
    if (deleted.url) {
      removeCorsOrigin(deleted.url);
    }

    await retireTeamAfterSave(deleted.slug, existing.allowedResources, null);
    await archiveApplicationCatalogue(catalogue);

    publishEvent("application.changed");

    await reply.status(204).send();
  });

  // POST /api/admin/applications/:id/rotate-secret
  fastify.post<{ Params: { id: string } }>(
    "/:id/rotate-secret",
    async (req, reply) => {
      const [app] = await db
        .select({
          id: applications.id,
          slug: applications.slug,
          isPublic: applications.isPublic,
        })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      if (app.isPublic) {
        throw ERR.APP_001("Public clients do not have a client secret");
      }

      const newSecret = randomBytes(32).toString("hex");
      const hashedSecret = hashClientSecret(newSecret);

      await db
        .update(oauthClient)
        .set({ clientSecret: hashedSecret })
        .where(eq(oauthClient.clientId, app.slug));

      // Invalidate every token minted with the previous secret.
      await revokeClientTokens(app.slug);

      await reply.send({ clientSecret: newSecret });
    },
  );

  // ── App ↔ User access management ─────────────────────────────────────────────

  // GET /api/admin/applications/:id/users — list all users associated with this app.
  // Augments each row with `lastLoginAt` scoped to this application (computed
  // from `login_history`). A single grouped sub-select keeps this to one round
  // trip even when the membership list is large.
  fastify.get<{
    Params: { id: string };
    Querystring: { page?: string; limit?: string; search?: string };
  }>("/:id/users", async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20),
    );
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim().slice(0, 200) || undefined;
    const searchFilter = search
      ? or(
          ilike(userTable.name, `%${search}%`),
          ilike(userTable.email, `%${search}%`),
        )
      : undefined;
    const where = and(
      eq(userApplications.applicationId, req.params.id),
      searchFilter,
    );

    const [{ total }] = await db
      .select({ total: countDistinct(userApplications.userId) })
      .from(userApplications)
      .leftJoin(userTable, eq(userApplications.userId, userTable.id))
      .where(where);

    // A user may hold several roles (user_app_roles PK is user+app+role), so the
    // join would return one row per role. DISTINCT ON keeps exactly one row per
    // user, otherwise the UI shows duplicate rows and deleting one "removes both".
    const rows = await db
      .selectDistinctOn([userApplications.userId], {
        userId: userApplications.userId,
        isActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
        createdAt: userApplications.createdAt,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        roleId: userAppRoles.roleId,
      })
      .from(userApplications)
      .leftJoin(userTable, eq(userApplications.userId, userTable.id))
      .leftJoin(
        userAppRoles,
        and(
          eq(userAppRoles.userId, userApplications.userId),
          eq(userAppRoles.applicationId, userApplications.applicationId),
        ),
      )
      .where(where)
      .orderBy(userApplications.userId, userAppRoles.createdAt)
      .limit(limit)
      .offset(offset);

    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    const lastLoginByUser = new Map<
      string,
      { lastLoginAt: Date; lastIp: string | null; lastUserAgent: string | null }
    >();
    if (userIds.length > 0) {
      const lastLogins = await db
        .selectDistinctOn([loginHistory.userId], {
          userId: loginHistory.userId,
          lastLoginAt: loginHistory.loggedAt,
          lastIp: loginHistory.ipAddress,
          lastUserAgent: loginHistory.userAgent,
        })
        .from(loginHistory)
        .where(
          and(
            eq(loginHistory.applicationId, req.params.id),
            inArray(loginHistory.userId, userIds),
          ),
        )
        .orderBy(loginHistory.userId, desc(loginHistory.loggedAt));
      for (const r of lastLogins) {
        lastLoginByUser.set(r.userId, {
          lastLoginAt: r.lastLoginAt,
          lastIp: r.lastIp,
          lastUserAgent: r.lastUserAgent,
        });
      }
    }

    const enriched = rows.map((r) => {
      const last = lastLoginByUser.get(r.userId);
      return {
        ...r,
        lastLoginAt: last?.lastLoginAt ?? null,
        lastIp: last?.lastIp ?? null,
        lastUserAgent: last?.lastUserAgent ?? null,
      };
    });

    await reply.send({ users: enriched, total, page, limit });
  });

  // GET /api/admin/applications/:id/subscriptions — compact rows used by the
  // financial tab. Keeping this separate from the paginated users table means
  // revenue KPIs do not depend on which page of users is visible.
  fastify.get<{ Params: { id: string } }>(
    "/:id/subscriptions",
    async (req, reply) => {
      const subscriptions = await db
        .select({
          userId: userSubscriptions.userId,
          planId: userSubscriptions.planId,
          isActive: userSubscriptions.isActive,
        })
        .from(userSubscriptions)
        .where(eq(userSubscriptions.applicationId, req.params.id));
      await reply.send({ subscriptions });
    },
  );

  // GET /api/admin/applications/:id/users/:userId/history — paginated login
  // history for a single user inside a single application. Powers the history
  // modal opened from the row-action icon in the app users tab.
  fastify.get<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId/history",
    async (req, reply) => {
      const query = req.query as Record<string, string>;
      const page = Math.max(1, parseInt(query.page ?? "1", 10));
      const limit = Math.min(
        100,
        Math.max(1, parseInt(query.limit ?? "20", 10)),
      );
      const offset = (page - 1) * limit;

      const where = and(
        eq(loginHistory.applicationId, req.params.id),
        eq(loginHistory.userId, req.params.userId),
      );

      const [{ total }] = await db
        .select({ total: count() })
        .from(loginHistory)
        .where(where);

      const entries = await db
        .select({
          id: loginHistory.id,
          loggedAt: loginHistory.loggedAt,
          ipAddress: loginHistory.ipAddress,
          userAgent: loginHistory.userAgent,
          sessionId: loginHistory.sessionId,
        })
        .from(loginHistory)
        .where(where)
        .orderBy(desc(loginHistory.loggedAt))
        .limit(limit)
        .offset(offset);

      await reply.send({ entries, total, page, limit });
    },
  );

  // POST /api/admin/applications/:id/users — grant a user access to this app
  fastify.post<{ Params: { id: string } }>("/:id/users", async (req, reply) => {
    const parsed = grantUserAccessSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid data", parsed.error.flatten());

    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!app) throw ERR.APP_002();

    // Validate the plan up front so an unknown/foreign plan fails before we
    // grant access (fail-fast; no half-applied request).
    if (parsed.data.subscriptionPlanId) {
      await assertPlanBelongsToApp(
        parsed.data.subscriptionPlanId,
        req.params.id,
      );
    }

    const [ua] = await db
      .insert(userApplications)
      .values({
        userId: parsed.data.userId,
        applicationId: req.params.id,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [userApplications.userId, userApplications.applicationId],
        set: { isActive: true },
      })
      .returning();

    if (parsed.data.roleId && ua) {
      // Explicit role provided — assign it directly after verifying it belongs
      // to this application (prevents cross-app role injection).
      await assertRoleBelongsToApp(parsed.data.roleId, req.params.id);
      await db
        .insert(userAppRoles)
        .values({
          userId: parsed.data.userId,
          applicationId: req.params.id,
          roleId: parsed.data.roleId,
        })
        .onConflictDoNothing();
    } else {
      // No explicit role — auto-assign the default role if one is configured
      await assignDefaultRoleIfNeeded(parsed.data.userId, req.params.id);
    }

    // Assign the requested plan, else fall back to the app's default plan.
    await assignRequestedOrDefaultPlan({
      userId: parsed.data.userId,
      applicationId: req.params.id,
      planId: parsed.data.subscriptionPlanId,
      actorUserId: await getActorUserId(req),
      reason: parsed.data.reason ?? null,
    });

    await reply.status(201).send({ ok: true });
  });

  // POST /api/admin/applications/:id/users/bulk — grant many users at once
  fastify.post<{ Params: { id: string } }>(
    "/:id/users/bulk",
    async (req, reply) => {
      const parsed = bulkGrantUserAccessSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid data", parsed.error.flatten());

      const [app] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      // Resolve the candidate users (id + email). Email lets us skip accounts
      // that already have access through a duplicate user record.
      let candidates: Array<{ id: string; email: string }>;
      if (parsed.data.organizationId) {
        candidates = await db
          .select({ id: userTable.id, email: userTable.email })
          .from(member)
          .innerJoin(userTable, eq(member.userId, userTable.id))
          .where(eq(member.organizationId, parsed.data.organizationId));
        if (candidates.length === 0) {
          throw ERR.APP_001("This organization has no members");
        }
      } else {
        const ids = [...new Set(parsed.data.userIds ?? [])];
        candidates = await db
          .select({ id: userTable.id, email: userTable.email })
          .from(userTable)
          .where(inArray(userTable.id, ids));
      }

      // Dedupe within the request, then drop anyone who already has access.
      const uniqueCandidates = [
        ...new Map(candidates.map((c) => [c.id, c])).values(),
      ];
      const existing = await db
        .select({ userId: userApplications.userId, email: userTable.email })
        .from(userApplications)
        .leftJoin(userTable, eq(userApplications.userId, userTable.id))
        .where(eq(userApplications.applicationId, req.params.id));
      const existingIds = new Set(existing.map((e) => e.userId));
      const existingEmails = new Set(
        existing
          .map((e) => (e.email ?? "").toLowerCase())
          .filter((e) => e !== ""),
      );
      const toGrant = uniqueCandidates.filter(
        (c) =>
          !existingIds.has(c.id) && !existingEmails.has(c.email.toLowerCase()),
      );
      const skipped = uniqueCandidates.length - toGrant.length;

      if (parsed.data.roleId) {
        await assertRoleBelongsToApp(parsed.data.roleId, req.params.id);
      }
      // Validate the plan before granting anything, so an unknown/foreign plan
      // cannot leave a batch of access rows behind a 404.
      if (parsed.data.subscriptionPlanId) {
        await assertPlanBelongsToApp(
          parsed.data.subscriptionPlanId,
          req.params.id,
        );
      }

      if (toGrant.length === 0) {
        await reply.status(200).send({ granted: 0, skipped });
        return;
      }

      await db
        .insert(userApplications)
        .values(
          toGrant.map((c) => ({
            userId: c.id,
            applicationId: req.params.id,
            isActive: true,
          })),
        )
        .onConflictDoUpdate({
          target: [userApplications.userId, userApplications.applicationId],
          set: { isActive: true },
        });

      const actorId = await getActorUserId(req);

      for (const { id: userId } of toGrant) {
        if (parsed.data.roleId) {
          await db
            .insert(userAppRoles)
            .values({
              userId,
              applicationId: req.params.id,
              roleId: parsed.data.roleId,
            })
            .onConflictDoNothing();
        } else {
          await assignDefaultRoleIfNeeded(userId, req.params.id);
        }
        await assignRequestedOrDefaultPlan({
          userId,
          applicationId: req.params.id,
          planId: parsed.data.subscriptionPlanId,
          actorUserId: actorId,
          reason: parsed.data.reason ?? null,
        });
      }

      await reply.status(201).send({ granted: toGrant.length, skipped });
    },
  );

  // PATCH /api/admin/applications/:id/users/:userId — update user access (toggle, role, plan)
  fastify.patch<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId",
    async (req, reply) => {
      const parsed = updateUserAccessSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid data", parsed.error.flatten());

      const { subscriptionPlanId, expiresAt } = parsed.data;
      const writesPlan = subscriptionPlanId !== undefined;
      const writesExpiry = expiresAt !== undefined;

      // Validate the plan up front — before the access row or the role is
      // mutated — so a foreign/unknown plan cannot leave a half-applied request.
      if (typeof subscriptionPlanId === "string") {
        await assertPlanBelongsToApp(subscriptionPlanId, req.params.id);
      }

      if (parsed.data.isActive !== undefined) {
        await db
          .update(userApplications)
          .set({ isActive: parsed.data.isActive })
          .where(
            and(
              eq(userApplications.userId, req.params.userId),
              eq(userApplications.applicationId, req.params.id),
            ),
          );

        // Revoking access must also burn the user's OAuth refresh tokens for
        // this app, otherwise they keep minting access tokens indefinitely.
        // Scoped to one app by design: it must not end the shared SSO session.
        // No back-channel logout is sent here — that fires on session end —
        // so the application learns at the next refresh attempt.
        if (parsed.data.isActive === false) {
          const [app] = await db
            .select({ slug: applications.slug })
            .from(applications)
            .where(eq(applications.id, req.params.id))
            .limit(1);
          if (app) {
            await revokeUserClientTokens(req.params.userId, app.slug);
          }
        }
      }

      if (parsed.data.roleId !== undefined) {
        // Validate the new role (when provided) BEFORE mutating anything, so a
        // bad roleId cannot strip the user's current role as a side effect.
        if (parsed.data.roleId !== null) {
          await assertRoleBelongsToApp(parsed.data.roleId, req.params.id);
        }
        await db
          .delete(userAppRoles)
          .where(
            and(
              eq(userAppRoles.userId, req.params.userId),
              eq(userAppRoles.applicationId, req.params.id),
            ),
          );
        if (parsed.data.roleId !== null) {
          await db
            .insert(userAppRoles)
            .values({
              userId: req.params.userId,
              applicationId: req.params.id,
              roleId: parsed.data.roleId,
            })
            .onConflictDoNothing();
        }
      }

      if (writesPlan || writesExpiry) {
        // An expiry-only payload keeps the current plan; a plan payload with a
        // null plan revokes the subscription.
        const planId = writesPlan
          ? subscriptionPlanId
          : await getCurrentSubscriptionPlanId(
              req.params.userId,
              req.params.id,
            );
        if (writesPlan || planId !== null) {
          await setUserSubscription({
            userId: req.params.userId,
            applicationId: req.params.id,
            planId,
            source: "admin",
            actorUserId: await getActorUserId(req),
            reason: parsed.data.reason ?? null,
            expiresAt: writesExpiry
              ? expiresAt
                ? new Date(expiresAt)
                : null
              : undefined,
          });
        }
      }

      // When activating a user, auto-assign the default plan if none assigned yet
      if (parsed.data.isActive === true) {
        await assignDefaultPlanIfNeeded(req.params.userId, req.params.id);
      }

      await reply.send({ ok: true });
    },
  );

  // DELETE /api/admin/applications/:id/users/:userId — revoke user access
  fastify.delete<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId",
    async (req, reply) => {
      const { id: appId, userId } = req.params;

      // Burn the user's OAuth tokens for this app before deleting the access
      // rows, so a held refresh token cannot resurrect the grant.
      const [app] = await db
        .select({ slug: applications.slug })
        .from(applications)
        .where(eq(applications.id, appId))
        .limit(1);
      if (app) {
        await revokeUserClientTokens(userId, app.slug);
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(userAppRoles)
          .where(
            and(
              eq(userAppRoles.userId, userId),
              eq(userAppRoles.applicationId, appId),
            ),
          );
        await tx
          .delete(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.userId, userId),
              eq(userSubscriptions.applicationId, appId),
            ),
          );
        await tx
          .delete(consumptionAggregates)
          .where(
            and(
              eq(consumptionAggregates.userId, userId),
              eq(consumptionAggregates.applicationId, appId),
            ),
          );
        await tx
          .delete(consumptionEntries)
          .where(
            and(
              eq(consumptionEntries.userId, userId),
              eq(consumptionEntries.applicationId, appId),
            ),
          );
        await tx
          .delete(userApplications)
          .where(
            and(
              eq(userApplications.userId, userId),
              eq(userApplications.applicationId, appId),
            ),
          );
      });
      await reply.status(204).send();
    },
  );

  // GET /api/admin/applications/:id/consumption — consumption aggregates for this app
  fastify.get<{ Params: { id: string } }>(
    "/:id/consumption",
    async (req, reply) => {
      const rows = await db
        .select({
          userId: consumptionAggregates.userId,
          userName: userTable.name,
          userEmail: userTable.email,
          subscriptionPlanId: userApplications.subscriptionPlanId,
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .leftJoin(userTable, eq(consumptionAggregates.userId, userTable.id))
        .leftJoin(
          userApplications,
          and(
            eq(userApplications.userId, consumptionAggregates.userId),
            eq(
              userApplications.applicationId,
              consumptionAggregates.applicationId,
            ),
          ),
        )
        .where(eq(consumptionAggregates.applicationId, req.params.id))
        .orderBy(consumptionAggregates.userId, consumptionAggregates.key);

      await reply.send({ entries: rows });
    },
  );

  // PATCH /api/admin/applications/:id/providers — update per-app social providers
  const updateProvidersSchema = z.object({
    enabledSocialProviders: z.array(socialProviderSchema).nullable(),
  });

  fastify.patch<{ Params: { id: string } }>(
    "/:id/providers",
    async (req, reply) => {
      const parsed = updateProvidersSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ERR.APP_001("Invalid providers data");
      }

      const [app] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      const [updated] = await db
        .update(applications)
        .set({ enabledSocialProviders: parsed.data.enabledSocialProviders })
        .where(eq(applications.id, req.params.id))
        .returning();

      publishEvent("application.changed");

      await reply.send({ application: updated });
    },
  );
}
