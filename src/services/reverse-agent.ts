import { generateId } from "better-auth";
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "../db/auth-schema.js";
import { applications } from "../db/schema.js";
import { logger } from "../logger.js";
import { invalidateAudiencesCache } from "./oauth-tokens.js";

export const REVERSE_AGENT_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "tunnel:serve",
] as const;

const REVERSE_AGENT_NAME = "Reverse Agent";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Provision the public device-flow client used by reverse-agent and the relay
 * resource it requests. Idempotent: every startup converges the rows without
 * touching unrelated clients or admin-edited resource policy beyond the
 * fields this contract owns.
 */
export async function ensureReverseAgent(): Promise<void> {
  const resource = config.reverseAgent.resource;
  if (!resource) return;
  const clientId = config.reverseAgent.clientId;

  const [existing] = await db
    .select({ id: applications.id, isSystem: applications.isSystem })
    .from(applications)
    .where(eq(applications.slug, clientId))
    .limit(1);
  if (existing && !existing.isSystem) {
    throw new Error(
      `[bootstrap] ${clientId} is already an application but not a system client; ` +
        "choose another REVERSE_AGENT_CLIENT_ID",
    );
  }

  const [app] = existing
    ? await db
        .update(applications)
        .set({
          name: REVERSE_AGENT_NAME,
          description: "Public device-flow client for reverse-agent enrolment",
          isActive: true,
          isSystem: true,
          isPublic: true,
          skipConsent: true,
          allowRegister: false,
          allowedScopes: [...REVERSE_AGENT_SCOPES],
          redirectUris: [],
          url: null,
          allowedResources: [resource],
          updatedAt: new Date(),
        })
        .where(eq(applications.id, existing.id))
        .returning({ id: applications.id })
    : await db
        .insert(applications)
        .values({
          name: REVERSE_AGENT_NAME,
          slug: clientId,
          description: "Public device-flow client for reverse-agent enrolment",
          isActive: true,
          isSystem: true,
          isPublic: true,
          skipConsent: true,
          allowRegister: false,
          allowedScopes: [...REVERSE_AGENT_SCOPES],
          redirectUris: [],
          url: null,
          allowedResources: [resource],
        })
        .returning({ id: applications.id });
  if (!app)
    throw new Error("[bootstrap] reverse-agent application was not written");

  await db
    .insert(oauthClient)
    .values({
      id: generateId(),
      clientId,
      clientSecret: null,
      disabled: false,
      skipConsent: true,
      scopes: [...REVERSE_AGENT_SCOPES],
      clientCredentialsScopes: [],
      name: REVERSE_AGENT_NAME,
      redirectUris: [],
      postLogoutRedirectUris: [],
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      grantTypes: [DEVICE_GRANT_TYPE, "refresh_token"],
      responseTypes: [],
      requirePKCE: false,
      metadata: { clientId, applicationId: app.id },
    })
    .onConflictDoUpdate({
      target: oauthClient.clientId,
      set: {
        clientSecret: null,
        disabled: false,
        skipConsent: true,
        scopes: [...REVERSE_AGENT_SCOPES],
        tokenEndpointAuthMethod: "none",
        applicationType: "native",
        grantTypes: [DEVICE_GRANT_TYPE, "refresh_token"],
        responseTypes: [],
        requirePKCE: false,
        metadata: sql`${oauthClient.metadata} || ${JSON.stringify({
          clientId,
          applicationId: app.id,
        })}::jsonb`,
        updatedAt: new Date(),
      },
    });

  await db
    .insert(oauthResource)
    .values({
      id: generateId(),
      identifier: resource,
      name: config.reverseAgent.resourceName,
      accessTokenTtl: config.reverseAgent.accessTokenTtlSeconds,
    })
    .onConflictDoUpdate({
      target: oauthResource.identifier,
      set: {
        name: config.reverseAgent.resourceName,
        // Respect a TTL an admin pinned through the resource API.
        accessTokenTtl: sql`coalesce(${oauthResource.accessTokenTtl}, ${config.reverseAgent.accessTokenTtlSeconds})`,
        updatedAt: new Date(),
      },
    });

  await db
    .insert(oauthClientResource)
    .values({ id: generateId(), clientId, resourceId: resource })
    .onConflictDoNothing();

  invalidateAudiencesCache();
  logger.info(
    { clientId, resource },
    "[bootstrap] reverse-agent device client ensured",
  );
}
