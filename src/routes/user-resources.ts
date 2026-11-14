import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { ERR } from "../errors.js";
import {
  getRequestSession,
  requireAppDelegation,
  requireSession,
} from "../middleware.js";
import { RESOURCE_TYPES } from "../services/resource-uri.js";
import { listAccessibleResources } from "../services/resource-sharing/accessible.js";
import { listResourceCatalogue } from "../services/resource-sharing/catalogue.js";
import {
  getGrantForOwner,
  listGrantsForOwner,
  revokeResourceGrant,
  updateResourceGrant,
} from "../services/resource-sharing/grants.js";
import { listOwnerApplications } from "../services/resource-sharing/delegation.js";
import { listOwnerMembers } from "../services/resource-sharing/members.js";
import { listOwnerPlans } from "../services/resource-sharing/owner-plans.js";
import {
  acceptResourceInvitation,
  buildResourceInvitationUrl,
  createResourceInvitation,
  listResourceInvitationsForOwner,
  revokeResourceInvitation,
  toPublicResourceInvitation,
} from "../services/resource-sharing/invitations.js";
import {
  createSharedResource,
  getSharedResource,
  listSharedResources,
  updateSharedResource,
} from "../services/resource-sharing/registry.js";
import {
  RESOURCE_STATUSES,
  RESOURCE_VISIBILITIES,
  type SharedResource,
} from "../services/resource-sharing/types.js";
import {
  getOwnerUsage,
  USAGE_GROUP_BY,
} from "../services/resource-sharing/usage.js";
import { sendResourceInvitationEmail } from "../services/email.js";
import { isMailConfigured } from "../services/mail/index.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const appParamsSchema = z.object({ appId: z.string().uuid() });
const resourceParamsSchema = appParamsSchema.extend({
  resourceId: z.string().uuid(),
});
const grantParamsSchema = appParamsSchema.extend({
  grantId: z.string().uuid(),
});
const invitationParamsSchema = z.object({ token: z.string().min(1).max(200) });
const ownerInvitationParamsSchema = appParamsSchema.extend({
  invitationId: z.string().uuid(),
});

const usageQuerySchema = z
  .object({
    groupBy: z.enum(USAGE_GROUP_BY).default("user"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const accessibleQuerySchema = z
  .object({
    clientId: z.string().trim().min(1).max(256),
    audience: z.string().trim().min(1).max(2048).optional(),
    resourceType: z.enum(RESOURCE_TYPES).optional(),
  })
  .strict();

const resourceBodySchema = z
  .object({
    resourceType: z.enum(RESOURCE_TYPES),
    slug: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(200),
    upstreamRef: z.string().trim().min(1).max(2048).nullable().optional(),
    status: z.enum(RESOURCE_STATUSES).optional(),
    visibility: z.enum(RESOURCE_VISIBILITIES).optional(),
    defaultPlanId: z.string().uuid().nullable().optional(),
  })
  .strict();

const resourcePatchSchema = z
  .object({
    slug: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    upstreamRef: z.string().trim().min(1).max(2048).nullable().optional(),
    status: z.enum(RESOURCE_STATUSES).optional(),
    visibility: z.enum(RESOURCE_VISIBILITIES).optional(),
    defaultPlanId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

const grantPatchSchema = z
  .object({
    resourceId: z.string().uuid().nullable().optional(),
    planId: z.string().uuid().optional(),
    allowedClientIds: z
      .array(z.string().trim().min(1).max(256))
      .min(1)
      .nullable()
      .optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

const invitationBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    planId: z.string().uuid(),
    resourceId: z.string().uuid().nullable().optional(),
    allowedClientIds: z
      .array(z.string().trim().min(1).max(256))
      .min(1)
      .nullable()
      .optional(),
    ttlHours: z.number().int().min(1).max(168).optional(),
  })
  .strict();

function asDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

async function requireOwnedResource(
  resourceId: string,
  ownerApplicationId: string,
): Promise<SharedResource> {
  const resource = await getSharedResource(resourceId);
  if (resource.ownerApplicationId !== ownerApplicationId) {
    throw ERR.RES_002();
  }
  return resource;
}

/**
 * Owner and subject APIs for cross-application resource sharing. Mounted under
 * `/api/user` only when RESOURCE_SHARING_ENABLED is on.
 *
 * The subject is always the verified session user. Application ids, resource
 * ids and grant ids in the path are treated as untrusted input: ownership is
 * checked and any foreign or missing id answers the same 404.
 */
export async function userResourceRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/accessible-resources",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;
      const query = accessibleQuerySchema.parse(req.query);
      const types = query.resourceType
        ? [query.resourceType]
        : [...RESOURCE_TYPES];
      const result = [];
      for (const resourceType of types) {
        const accessible = await listAccessibleResources({
          subjectId: userId,
          clientId: query.clientId,
          audience: query.audience ?? config.betterAuth.url,
          resourceType,
        });
        result.push(...accessible);
      }
      await reply.send({ resources: result });
    },
  );

  fastify.get(
    "/resource-catalogue",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;
      const resources = await listResourceCatalogue({ subjectId: userId });
      await reply.send({ resources });
    },
  );

  fastify.get("/apps", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const apps = await listOwnerApplications(userId);
    await reply.send({ apps });
  });

  fastify.get("/apps/:appId/members", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:read",
    );
    if (!userId) return;
    const members = await listOwnerMembers(appId);
    await reply.send({ members });
  });

  fastify.get("/apps/:appId/plans", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "grants:manage",
    );
    if (!userId) return;
    const plans = await listOwnerPlans(appId);
    await reply.send({ plans });
  });

  fastify.get("/apps/:appId/invitations", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "grants:manage",
    );
    if (!userId) return;
    const invitations = await listResourceInvitationsForOwner(appId);
    await reply.send({ invitations });
  });

  fastify.delete(
    "/apps/:appId/invitations/:invitationId",
    async (req, reply) => {
      const { appId, invitationId } = ownerInvitationParamsSchema.parse(
        req.params,
      );
      const userId = await requireAppDelegation(
        req,
        reply,
        appId,
        "grants:manage",
      );
      if (!userId) return;
      const invitation = await revokeResourceInvitation(invitationId, appId);
      await reply.send({ invitation: toPublicResourceInvitation(invitation) });
    },
  );

  fastify.get("/apps/:appId/shared-resources", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:read",
    );
    if (!userId) return;
    const resources = await listSharedResources(appId);
    await reply.send({ resources });
  });

  fastify.get(
    "/apps/:appId/shared-resources/:resourceId",
    async (req, reply) => {
      const { appId, resourceId } = resourceParamsSchema.parse(req.params);
      const userId = await requireAppDelegation(
        req,
        reply,
        appId,
        "resources:read",
      );
      if (!userId) return;
      const resource = await requireOwnedResource(resourceId, appId);
      await reply.send({ resource });
    },
  );

  fastify.post("/apps/:appId/shared-resources", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:manage",
    );
    if (!userId) return;
    const body = resourceBodySchema.parse(req.body);
    const resource = await createSharedResource({
      ownerApplicationId: appId,
      ...body,
    });
    await reply.status(201).send({ resource });
  });

  fastify.patch(
    "/apps/:appId/shared-resources/:resourceId",
    async (req, reply) => {
      const { appId, resourceId } = resourceParamsSchema.parse(req.params);
      const userId = await requireAppDelegation(
        req,
        reply,
        appId,
        "resources:manage",
      );
      if (!userId) return;
      await requireOwnedResource(resourceId, appId);
      const body = resourcePatchSchema.parse(req.body);
      const resource = await updateSharedResource(resourceId, body);
      await reply.send({ resource });
    },
  );

  /**
   * Soft delete. M1.6 derives gateway access-group membership from rows that
   * still exist, so physically deleting one would leave stale access. The row
   * transitions to `disabled` through the registry service, which queues the
   * owner-scoped reconciliation.
   */
  fastify.delete(
    "/apps/:appId/shared-resources/:resourceId",
    async (req, reply) => {
      const { appId, resourceId } = resourceParamsSchema.parse(req.params);
      const userId = await requireAppDelegation(
        req,
        reply,
        appId,
        "resources:manage",
      );
      if (!userId) return;
      await requireOwnedResource(resourceId, appId);
      const resource = await updateSharedResource(resourceId, {
        status: "disabled",
      });
      await reply.send({ resource });
    },
  );

  fastify.get("/apps/:appId/usage", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:read",
    );
    if (!userId) return;
    const query = usageQuerySchema.parse(req.query);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (from.getTime() >= to.getTime()) {
      throw ERR.RES_001("from must be before to");
    }
    const usage = await getOwnerUsage({
      ownerApplicationId: appId,
      groupBy: query.groupBy,
      from,
      to,
      limit: query.limit,
      offset: query.offset,
    });
    await reply.send(usage);
  });

  fastify.get("/apps/:appId/grants", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "grants:manage",
    );
    if (!userId) return;
    const grants = await listGrantsForOwner(appId);
    await reply.send({ grants });
  });

  fastify.put("/apps/:appId/grants/:grantId", async (req, reply) => {
    const { appId, grantId } = grantParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "grants:manage",
    );
    if (!userId) return;
    const body = grantPatchSchema.parse(req.body);
    const grant = await updateResourceGrant(grantId, appId, {
      ...body,
      expiresAt: asDate(body.expiresAt),
    });
    await reply.send({ grant });
  });

  fastify.delete("/apps/:appId/grants/:grantId", async (req, reply) => {
    const { appId, grantId } = grantParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "grants:manage",
    );
    if (!userId) return;
    await getGrantForOwner(grantId, appId);
    const grant = await revokeResourceGrant(grantId);
    await reply.send({ grant });
  });

  fastify.post("/apps/:appId/invitations", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "grants:manage",
    );
    if (!userId) return;
    const body = invitationBodySchema.parse(req.body);
    const session = await getRequestSession(req);
    const created = await createResourceInvitation({
      email: body.email,
      ownerApplicationId: appId,
      planId: body.planId,
      resourceId: body.resourceId ?? null,
      allowedClientIds: body.allowedClientIds ?? null,
      ttlHours: body.ttlHours,
      createdBy: userId,
    });
    const inviteUrl = buildResourceInvitationUrl(created.token);
    let emailSent = false;
    if (isMailConfigured()) {
      await sendResourceInvitationEmail(body.email, {
        url: inviteUrl,
        expiresInHours: body.ttlHours ?? 72,
        ownerAppName: created.ownerAppName,
        ownerAppSlug: created.ownerAppSlug,
        planName: created.planName,
        resourceName: created.resourceName,
        inviterName: session?.user.name ?? undefined,
      });
      emailSent = true;
    }
    await reply.status(201).send({
      invitation: toPublicResourceInvitation(created.invitation),
      inviteUrl,
      emailSent,
    });
  });

  fastify.post("/resource-invitations/accept", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const body = invitationParamsSchema.parse(req.body);
    const session = await getRequestSession(req);
    const grant = await acceptResourceInvitation({
      token: body.token,
      subjectId: userId,
      email: session?.user.email ?? "",
      emailVerified: session?.user.emailVerified === true,
    });
    await reply.send({ grant });
  });
}
