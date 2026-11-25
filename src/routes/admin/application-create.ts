import type { FastifyInstance } from "fastify";
import { generateId } from "better-auth";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  appRoles,
  userApplications,
  userAppRoles,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import { GUEST_ROLE } from "../../services/resources/authority.js";
import { provisionPlanProductBestEffort } from "../../services/billing/catalog.js";
import { oauthClient, user as userTable } from "../../db/auth-schema.js";
import { eq } from "drizzle-orm";
import {
  withResourceSharingScope,
  withTeamsScope,
} from "../../compat/scopes.js";
import { ERR } from "../../errors.js";
import { randomBytes } from "node:crypto";
import { addCorsOrigin } from "../../runtime-config.js";
import {
  assertAllowedResources,
  replaceClientResource,
} from "../../services/oauth-resources.js";
import { getRequestSession } from "../../middleware.js";
import { USER_NAMESPACE_PREFIX } from "../../services/resources/uri.js";
import {
  assertReachableBackchannelLogoutUri,
  backchannelLogoutUriSchema,
} from "../../services/backchannel-logout-uri.js";
import {
  assertReachableResourceWebhookUrl,
  encryptResourceWebhookSecret,
  generateResourceWebhookSecret,
  resourceWebhookUrlSchema,
} from "../../services/resources/webhooks.js";
import { ADMIN_ROOM, publishEvent } from "../../services/event-bus.js";
import { socialProviderSchema } from "./application-credentials.js";
import {
  allowedResourcesSchema,
  assertMaySetSystemFlag,
  metadataSchema,
  withResourceWebhookSecret,
} from "./application-fields.js";
import {
  assertOauthClientSettings,
  backchannelLogoutValues,
  effectivePostLogoutRedirectUris,
  effectiveRequirePKCE,
  effectiveTokenEndpointAuthMethod,
  hashClientSecret,
  mergeOauthView,
} from "./application-oauth-client.js";

const DEFAULT_PLAN_NAME = "free";
import { DEFAULT_MACHINE_SCOPES } from "../../services/machine-scopes.js";

export const createAppSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens")
    .refine((slug) => !slug.startsWith(USER_NAMESPACE_PREFIX), {
      message: `slug must not start with ${USER_NAMESPACE_PREFIX}, which is reserved for user namespaces`,
    }),
  description: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(false),
  isSystem: z.boolean().default(false),
  // Confidential clients may opt out of PKCE for legacy interoperability;
  // public clients always require it (enforced in the route).
  requirePKCE: z.boolean().default(true),
  // Confidential-client token endpoint authentication. Omitted = instance
  // default from TOKEN_ENDPOINT_AUTH_METHOD.
  tokenEndpointAuthMethod: z
    .enum(["client_secret_basic", "client_secret_post"])
    .optional(),
  skipConsent: z.boolean().default(false),
  isMfaRequired: z.boolean().default(false),
  allowRegister: z.boolean().default(false),
  billingMode: z.enum(["none", "delegated"]).default("none"),
  resourceSharingEnabled: z.boolean().default(false),
  teamsEnabled: z.boolean().default(false),
  autoShareRelayModels: z.boolean().default(false),
  // Optional callback auth-service POSTs signed resource-sharing events to.
  resourceWebhookUrl: resourceWebhookUrlSchema.nullable().optional(),
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
  url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "Use an http(s) URL",
    })
    .optional()
    .nullable(),
  // Protected resources (other applications' URLs, e.g. the LiteLLM gateway)
  // this application may request access tokens for (RFC 8707 `resource`).
  allowedResources: allowedResourcesSchema.default([]),
  icon: z.string().optional().nullable(),
  enabledSocialProviders: z.array(socialProviderSchema).nullable().optional(),
  metadata: metadataSchema.optional().default({}),
});

export async function applicationCreateRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // POST /api/admin/applications
  fastify.post("/", async (req, reply) => {
    const parsed = createAppSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ERR.APP_001("Invalid application data", parsed.error.flatten());
    }
    const data = parsed.data;
    if (data.autoShareRelayModels && !data.resourceSharingEnabled) {
      throw ERR.APP_001("Sharing relay models requires resource sharing");
    }
    if (data.isSystem) await assertMaySetSystemFlag(req);
    assertOauthClientSettings(data);

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
      await assertReachableBackchannelLogoutUri(data.backchannelLogoutUri);
    }
    if (data.resourceWebhookUrl) {
      await assertReachableResourceWebhookUrl(data.resourceWebhookUrl);
    }
    const resourceWebhookSecret = data.resourceWebhookUrl
      ? generateResourceWebhookSecret()
      : null;
    // Generate and hash the client secret (only for confidential clients)
    const rawSecret = data.isPublic ? null : randomBytes(32).toString("hex");
    const hashedSecret = rawSecret ? hashClientSecret(rawSecret) : null;
    const grantedScopes = withTeamsScope(
      withResourceSharingScope(data.allowedScopes, data.resourceSharingEnabled),
      data.teamsEnabled,
    );

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
          resourceSharingEnabled: data.resourceSharingEnabled,
          teamsEnabled: data.teamsEnabled,
          autoShareRelayModels: data.autoShareRelayModels,
          resourceWebhookUrl: data.resourceWebhookUrl ?? null,
          resourceWebhookSecret: resourceWebhookSecret
            ? encryptResourceWebhookSecret(resourceWebhookSecret)
            : null,
          allowedScopes: grantedScopes,
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
        scopes: grantedScopes,
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
        tokenEndpointAuthMethod: effectiveTokenEndpointAuthMethod(data),
        grantTypes: data.isPublic
          ? ["authorization_code", "refresh_token"]
          : ["authorization_code", "refresh_token", "client_credentials"],
        responseTypes: ["code"],
        requirePKCE: effectiveRequirePKCE(data),
        // Machine-to-machine scopes. Deliberately separate from the app's OIDC
        // `allowedScopes` (openid/profile/email are user-delegated and rejected
        // by the client_credentials grant). Public clients cannot use M2M. The
        // wallet scopes stay superadmin-only (see application-machine-scopes).
        clientCredentialsScopes: data.isPublic
          ? []
          : [...DEFAULT_MACHINE_SCOPES],
        metadata: {
          clientId: data.slug,
          applicationId: app.id,
          ...(data.tokenEndpointAuthMethod
            ? { tokenEndpointAuthMethodExplicit: "true" }
            : {}),
        },
      });

      return rows;
    });

    // ── Bootstrap macros ────────────────────────────────────────────────────
    // Run outside the main transaction so that failures here don't roll back
    // the application/oauthClient creation.

    // a) Create predefined roles: "user" (default), "admin" and "guest"
    // (signs in and accepts shares, creates no resource)
    const [userRole, adminRole] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(appRoles)
        .values([
          { applicationId: app!.id, name: "user", isDefault: true },
          { applicationId: app!.id, name: "admin", isDefault: false },
          { applicationId: app!.id, name: GUEST_ROLE, isDefault: false },
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
        appIcon: app!.icon,
        appUrl: app!.url,
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
      application: withResourceWebhookSecret(
        mergeOauthView(app!, {
          enableEndSession: data.enableEndSession,
          postLogoutRedirectUris: effectivePostLogoutRedirectUris(
            data.postLogoutRedirectUris,
            data.url,
          ),
          ...backchannelLogoutValues(data),
          requirePKCE: effectiveRequirePKCE(data),
          tokenEndpointAuthMethod: effectiveTokenEndpointAuthMethod(data),
          tokenEndpointAuthMethodExplicit:
            data.tokenEndpointAuthMethod !== undefined,
        }),
      ),
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
    publishEvent("application.changed", [ADMIN_ROOM]);

    await reply.status(201).send(response);
  });
}
