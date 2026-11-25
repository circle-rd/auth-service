import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { updateApplicationProducts } from "../../services/billing/catalog.js";
import { oauthClient } from "../../db/auth-schema.js";
import { eq, sql } from "drizzle-orm";
import {
  withResourceSharingScope,
  withTeamsScope,
} from "../../compat/scopes.js";
import { ERR } from "../../errors.js";
import { addCorsOrigin, removeCorsOrigin } from "../../runtime-config.js";
import {
  assertAllowedResources,
  replaceClientResource,
} from "../../services/oauth-resources.js";
import { assertReachableBackchannelLogoutUri } from "../../services/backchannel-logout-uri.js";
import {
  assertReachableResourceWebhookUrl,
  encryptResourceWebhookSecret,
  generateResourceWebhookSecret,
} from "../../services/resources/webhooks.js";
import { ADMIN_ROOM, appRoom, publishEvent } from "../../services/event-bus.js";
import { createAppSchema } from "./application-create.js";
import {
  allowedResourcesSchema,
  assertMaySetSystemFlag,
  metadataSchema,
  withResourceWebhookSecret,
} from "./application-fields.js";
import {
  assertOauthClientSettings,
  effectiveRequirePKCE,
  effectiveTokenEndpointAuthMethod,
  fetchOauthClientView,
  mergeOauthView,
} from "./application-oauth-client.js";

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
    requirePKCE: z.boolean().optional(),
    tokenEndpointAuthMethod: z
      .enum(["client_secret_basic", "client_secret_post"])
      .optional(),
    skipConsent: z.boolean().optional(),
    isMfaRequired: z.boolean().optional(),
    allowRegister: z.boolean().optional(),
    billingMode: z.enum(["none", "delegated"]).optional(),
    resourceSharingEnabled: z.boolean().optional(),
    teamsEnabled: z.boolean().optional(),
    autoShareRelayModels: z.boolean().optional(),
    allowedScopes: z.array(z.string()).optional(),
    redirectUris: z.array(z.string().url()).optional(),
    enableEndSession: z.boolean().optional(),
    postLogoutRedirectUris: z.array(z.string().url()).optional(),
    backchannelLogoutSessionRequired: z.boolean().optional(),
    allowedResources: allowedResourcesSchema.optional(),
    metadata: metadataSchema.optional(),
  });

export async function applicationUpdateRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // PATCH /api/admin/applications/:id
  fastify.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = updateAppSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid data", parsed.error.flatten());
    if (parsed.data.isSystem !== undefined) await assertMaySetSystemFlag(req);
    if (parsed.data.backchannelLogoutUri) {
      await assertReachableBackchannelLogoutUri(
        parsed.data.backchannelLogoutUri,
      );
    }
    if (parsed.data.resourceWebhookUrl) {
      await assertReachableResourceWebhookUrl(parsed.data.resourceWebhookUrl);
    }

    // Fetch the current URL before applying the update so we can diff it.
    const [before] = await db
      .select({
        url: applications.url,
        slug: applications.slug,
        name: applications.name,
        icon: applications.icon,
        allowedResources: applications.allowedResources,
        isPublic: applications.isPublic,
        isSystem: applications.isSystem,
        resourceWebhookSecret: applications.resourceWebhookSecret,
        allowedScopes: applications.allowedScopes,
        resourceSharingEnabled: applications.resourceSharingEnabled,
        teamsEnabled: applications.teamsEnabled,
        autoShareRelayModels: applications.autoShareRelayModels,
      })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!before) throw ERR.APP_002();

    if (
      (parsed.data.autoShareRelayModels ?? before.autoShareRelayModels) &&
      !(parsed.data.resourceSharingEnabled ?? before.resourceSharingEnabled)
    ) {
      throw ERR.APP_001("Sharing relay models requires resource sharing");
    }

    assertOauthClientSettings({
      isPublic: before.isPublic,
      isSystem: parsed.data.isSystem ?? before.isSystem,
      requirePKCE: parsed.data.requirePKCE,
      tokenEndpointAuthMethod: parsed.data.tokenEndpointAuthMethod,
    });

    // Re-validated on every update so a resource that disappeared since the
    // last save is reported instead of failing on the link insert.
    await assertAllowedResources(
      parsed.data.allowedResources ?? before.allowedResources,
      parsed.data.url !== undefined ? parsed.data.url : before.url,
    );

    // `enableEndSession`, `postLogoutRedirectUris` and the back-channel logout
    // settings live exclusively on the BetterAuth `oauthClient` row, not on
    // `applications` — strip them before updating the application table.
    const {
      enableEndSession: _ees,
      postLogoutRedirectUris: _plru,
      backchannelLogoutUri: _bclu,
      backchannelLogoutSessionRequired: _bclsr,
      resourceWebhookUrl,
      ...applicationData
    } = parsed.data;
    void _ees;
    void _plru;
    void _bclu;
    void _bclsr;

    const webhookUpdate =
      resourceWebhookUrl === undefined
        ? {}
        : {
            resourceWebhookUrl,
            resourceWebhookSecret: resourceWebhookUrl
              ? (before.resourceWebhookSecret ??
                encryptResourceWebhookSecret(generateResourceWebhookSecret()))
              : null,
          };

    const scopesChanged =
      parsed.data.allowedScopes !== undefined ||
      parsed.data.resourceSharingEnabled !== undefined ||
      parsed.data.teamsEnabled !== undefined;
    const grantedScopes = withTeamsScope(
      withResourceSharingScope(
        parsed.data.allowedScopes ?? before.allowedScopes,
        parsed.data.resourceSharingEnabled ?? before.resourceSharingEnabled,
      ),
      parsed.data.teamsEnabled ?? before.teamsEnabled,
    );
    const scopesUpdate = scopesChanged ? { allowedScopes: grantedScopes } : {};

    const [app] = await db
      .update(applications)
      .set({
        ...applicationData,
        ...webhookUpdate,
        ...scopesUpdate,
        updatedAt: new Date(),
      })
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
    if (scopesChanged) oauthUpdate.scopes = grantedScopes;
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
    if (parsed.data.requirePKCE !== undefined) {
      oauthUpdate.requirePKCE = effectiveRequirePKCE({
        isPublic: app.isPublic,
        requirePKCE: parsed.data.requirePKCE,
      });
    }
    if (parsed.data.tokenEndpointAuthMethod !== undefined) {
      oauthUpdate.tokenEndpointAuthMethod = effectiveTokenEndpointAuthMethod({
        isPublic: app.isPublic,
        isSystem: app.isSystem,
        tokenEndpointAuthMethod: parsed.data.tokenEndpointAuthMethod,
      });
      // Keep the explicit choice across the startup reconciliation that
      // otherwise realigns every client with TOKEN_ENDPOINT_AUTH_METHOD.
      oauthUpdate.metadata = sql`${oauthClient.metadata} || ${JSON.stringify({
        tokenEndpointAuthMethodExplicit: "true",
      })}::jsonb`;
    }
    if (parsed.data.isSystem === true) {
      // System clients are script-provisioned and always use HTTP Basic.
      oauthUpdate.tokenEndpointAuthMethod = app.isPublic
        ? "none"
        : "client_secret_basic";
    }

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

    // Keep the Stripe Products branded after the application's name, logo or URL.
    if (
      (parsed.data.name !== undefined && parsed.data.name !== before.name) ||
      (parsed.data.icon !== undefined && parsed.data.icon !== before.icon) ||
      (parsed.data.url !== undefined && parsed.data.url !== before.url)
    ) {
      await updateApplicationProducts({
        applicationId: app.id,
        appName: app.name,
        appIcon: app.icon,
        appUrl: app.url,
      });
    }

    const view = await fetchOauthClientView(app.slug);
    publishEvent("application.changed", [ADMIN_ROOM]);
    if (parsed.data.resourceSharingEnabled !== undefined) {
      publishEvent("catalogue.changed", [appRoom(app.id)]);
    }
    await reply.send({
      application: withResourceWebhookSecret(mergeOauthView(app, view)),
    });
  });
}
