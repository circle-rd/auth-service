import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { ERR } from "../errors.js";
import { appRoom, publishEvent } from "../services/event-bus.js";
import {
  getRequestSession,
  requireAppDelegation,
  requireResourceAppAdmin,
  requireSession,
} from "../middleware.js";
import {
  addExistingUserToApplication,
  listOwnerApplications,
  listOwnerMembers,
  listOwnerPlans,
} from "../services/resources/apps.js";
import {
  assertActiveMember,
  isApplicationAdmin,
} from "../services/resources/authority.js";
import {
  listActiveGrantCounts,
  listGrantsForApplication,
} from "../services/resources/grant-views.js";
import { listModelCandidates } from "../services/resources/model-candidates.js";
import {
  buildResourceInvitationUrl,
  createResourceInvitation,
  listResourceInvitationsForApplication,
  revokeResourceInvitation,
  toPublicResourceInvitation,
} from "../services/resources/invitations.js";
import {
  createApplicationScheme,
  deleteApplicationScheme,
  disableSchemeForApplication,
  enableSchemeForApplication,
  listApplicationSchemeCatalog,
  updateApplicationScheme,
} from "../services/resources/scheme-service.js";
import {
  createResource,
  listResourcesForApplication,
} from "../services/resources/registry.js";
import {
  getApplicationUsage,
  listAccessEvents,
  USAGE_GROUP_BY,
} from "../services/resources/usage.js";
import { RESOURCE_SCHEME_RE } from "../services/resources/uri.js";
import { supportedPermissions } from "../services/resources/schemes.js";
import {
  RESOURCE_EVENT_DECISIONS,
  RESOURCE_PERMISSIONS,
} from "../services/resources/types.js";
import {
  sendApplicationAccessEmail,
  sendResourceInvitationEmail,
} from "../services/email.js";
import { isMailConfigured } from "../services/mail/index.js";
import { resourceMetadataSchema } from "./resource-metadata.js";

const appParamsSchema = z.object({ appId: z.string().uuid() });
const schemeParamsSchema = appParamsSchema.extend({
  scheme: z.string().regex(RESOURCE_SCHEME_RE),
});
const invitationParamsSchema = appParamsSchema.extend({
  invitationId: z.string().uuid(),
});

const memberBodySchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();

const memberQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const appResourceCreateSchema = z
  .object({
    scheme: z.string().regex(RESOURCE_SCHEME_RE),
    locator: z.string().trim().min(1).max(255).optional(),
    displayName: z.string().trim().min(1).max(200),
    metadata: resourceMetadataSchema.optional(),
  })
  .strict();

const validatorUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Validator URL must use HTTP or HTTPS",
  });

const schemeIconSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) =>
      /^[a-z][a-z0-9-]{0,49}$/.test(value) || /^https:\/\/\S+$/.test(value),
    {
      message: "Icon must be an icon name or an HTTPS URL",
    },
  );

const schemeCreateSchema = z
  .object({
    scheme: z.string().regex(RESOURCE_SCHEME_RE),
    displayName: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    icon: schemeIconSchema.nullable().optional(),
    validatorUrl: validatorUrlSchema.nullable().optional(),
  })
  .strict();

const schemePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    icon: schemeIconSchema.nullable().optional(),
    validatorUrl: validatorUrlSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

const invitationCreateSchema = z.object({
  email: z.string().trim().email().max(320),
  resourceId: z.string().uuid(),
  permission: z.enum(RESOURCE_PERMISSIONS).optional(),
  ttlHours: z.number().int().min(1).max(168).optional(),
});

const usageQuerySchema = z
  .object({
    groupBy: z.enum(USAGE_GROUP_BY).default("resource"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const accessQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    decision: z.enum(RESOURCE_EVENT_DECISIONS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** A scheme or its enablement changed: every user enrolled in the application may see it. */
function announceCatalogueChanged(applicationId: string): void {
  publishEvent("catalogue.changed", [appRoom(applicationId)]);
}

export async function appResourceRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/apps", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    await reply.send({ apps: await listOwnerApplications(userId) });
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
    const query = memberQuerySchema.parse(req.query);
    const page = await listOwnerMembers(appId, query, userId);
    await reply.send({
      members: page.members,
      hasMore: page.hasMore,
      nextOffset: page.hasMore ? query.offset + query.limit : null,
    });
  });

  fastify.post("/apps/:appId/members", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    const body = memberBodySchema.parse(req.body);
    const added = await addExistingUserToApplication(userId, appId, body.email);
    if (added && isMailConfigured()) {
      const session = await getRequestSession(req);
      await sendApplicationAccessEmail(added.email, {
        url: `${config.betterAuth.url}/catalogue`,
        appName: added.applicationName,
        appSlug: added.applicationSlug,
        inviterName: session?.user.name ?? undefined,
      });
    }
    await reply.status(202).send({ accepted: true });
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
    await reply.send({ plans: await listOwnerPlans(appId) });
  });

  fastify.get("/apps/:appId/resources", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:read",
    );
    if (!userId) return;
    const resources = await listResourcesForApplication(appId);
    const counts = await listActiveGrantCounts(
      resources.map((resource) => resource.id),
    );
    await reply.send({
      resources: resources.map((resource) => ({
        ...resource,
        permissions: supportedPermissions(resource.scheme),
        grantCount: counts.get(resource.id) ?? 0,
      })),
    });
  });

  fastify.post("/apps/:appId/resources", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:manage",
    );
    if (!userId) return;
    const body = appResourceCreateSchema.parse(req.body);
    const resource = await createResource({
      applicationId: appId,
      scheme: body.scheme,
      locator: body.locator ?? null,
      displayName: body.displayName,
      ownerType: "application",
      ownerId: appId,
      metadata: body.metadata,
    });
    await reply.status(201).send({ resource });
  });

  fastify.get("/apps/:appId/model-candidates/managed", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireSession(req, reply);
    if (!userId) return;
    if (!(await isApplicationAdmin(userId, appId))) {
      await assertActiveMember(userId, appId);
    }
    await reply.send({
      models: await listModelCandidates({
        appId,
        userId,
        source: "managed",
      }),
    });
  });

  fastify.get("/apps/:appId/model-candidates/native", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireSession(req, reply);
    if (!userId) return;
    if (!(await isApplicationAdmin(userId, appId))) {
      await assertActiveMember(userId, appId);
    }
    await reply.send({
      models: await listModelCandidates({
        appId,
        userId,
        source: "native",
      }),
    });
  });

  fastify.get("/apps/:appId/schemes", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireSession(req, reply);
    if (!userId) return;
    await assertActiveMember(userId, appId);
    const schemes = (await listApplicationSchemeCatalog(appId)).filter(
      (scheme) => scheme.enabled,
    );
    await reply.send({ schemes });
  });

  fastify.get("/apps/:appId/resource-scheme-catalog", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    await reply.send({ schemes: await listApplicationSchemeCatalog(appId) });
  });

  fastify.post("/apps/:appId/schemes", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    const body = schemeCreateSchema.parse(req.body);
    const scheme = await createApplicationScheme({
      applicationId: appId,
      ...body,
    });
    announceCatalogueChanged(appId);
    await reply.status(201).send({ scheme });
  });

  fastify.patch("/apps/:appId/schemes/:scheme", async (req, reply) => {
    const { appId, scheme } = schemeParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    const body = schemePatchSchema.parse(req.body);
    const updated = await updateApplicationScheme(appId, scheme, body);
    announceCatalogueChanged(appId);
    await reply.send({ scheme: updated });
  });

  fastify.delete("/apps/:appId/schemes/:scheme", async (req, reply) => {
    const { appId, scheme } = schemeParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    await deleteApplicationScheme(appId, scheme);
    announceCatalogueChanged(appId);
    await reply.status(204).send();
  });

  fastify.put("/apps/:appId/schemes/:scheme/enable", async (req, reply) => {
    const { appId, scheme } = schemeParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    await enableSchemeForApplication(appId, scheme);
    announceCatalogueChanged(appId);
    await reply.status(204).send();
  });

  fastify.delete("/apps/:appId/schemes/:scheme/enable", async (req, reply) => {
    const { appId, scheme } = schemeParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    await disableSchemeForApplication(appId, scheme);
    announceCatalogueChanged(appId);
    await reply.status(204).send();
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
    await reply.send({ grants: await listGrantsForApplication(appId) });
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
    await reply.send({
      invitations: await listResourceInvitationsForApplication(appId),
    });
  });

  fastify.post("/apps/:appId/invitations", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireResourceAppAdmin(req, reply, appId);
    if (!userId) return;
    const body = invitationCreateSchema.parse(req.body);
    const created = await createResourceInvitation({
      email: body.email,
      resourceId: body.resourceId,
      actorUserId: userId,
      permission: body.permission,
      ttlHours: body.ttlHours,
    });
    const inviteUrl = buildResourceInvitationUrl(created.token);
    let emailSent = false;
    if (isMailConfigured()) {
      const session = await getRequestSession(req);
      try {
        await sendResourceInvitationEmail(body.email, {
          url: inviteUrl,
          expiresInHours: body.ttlHours ?? 72,
          ownerAppName: created.resource.applicationName,
          ownerAppSlug: created.resource.applicationSlug,
          resourceName: created.resource.displayName,
          inviterName: session?.user.name ?? undefined,
        });
        emailSent = true;
      } catch (err) {
        // The invitation exists and its URL is returned below: a mail outage
        // must not strand it. Log the failure class only, never the token URL.
        req.log.error(
          { error: err instanceof Error ? err.name : "unknown" },
          "resource invitation email could not be sent",
        );
      }
    }
    await reply.status(201).send({
      invitation: toPublicResourceInvitation(created.invitation),
      inviteUrl,
      emailSent,
    });
  });

  fastify.delete(
    "/apps/:appId/invitations/:invitationId",
    async (req, reply) => {
      const { appId, invitationId } = invitationParamsSchema.parse(req.params);
      const userId = await requireAppDelegation(
        req,
        reply,
        appId,
        "grants:manage",
      );
      if (!userId) return;
      const invitation = await revokeResourceInvitation(invitationId, userId);
      await reply.send({
        invitation: toPublicResourceInvitation(invitation),
      });
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
    if (
      query.groupBy === "user" &&
      !(await isApplicationAdmin(userId, appId))
    ) {
      throw ERR.AUTH_011(
        "User-level usage requires application administration",
      );
    }
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (from.getTime() >= to.getTime()) {
      throw ERR.RES_001("from must be before to");
    }
    await reply.send(
      await getApplicationUsage(appId, {
        groupBy: query.groupBy,
        from,
        to,
        limit: query.limit,
        offset: query.offset,
      }),
    );
  });

  fastify.get("/apps/:appId/access-events", async (req, reply) => {
    const { appId } = appParamsSchema.parse(req.params);
    const userId = await requireAppDelegation(
      req,
      reply,
      appId,
      "resources:read",
    );
    if (!userId) return;
    const query = accessQuerySchema.parse(req.query);
    const events = await listAccessEvents({
      applicationId: appId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      decision: query.decision,
      limit: query.limit,
      offset: query.offset,
    });
    await reply.send({ events });
  });
}
