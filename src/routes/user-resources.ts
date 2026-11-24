import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { RESOURCE_SELF_SCOPE } from "../compat/scopes.js";
import { config } from "../config.js";
import { ERR } from "../errors.js";
import {
  getRequestSession,
  requireSession,
  requireUserOrBearerCaller,
} from "../middleware.js";
import {
  BULK_SHARE_LIMIT,
  shareResourcesWithApplication,
} from "../services/resources/application-sharing.js";
import {
  loadSharingApplicationBySlug,
  type CallerApplication,
} from "../services/resources/application-scope.js";
import {
  listAccessibleResources,
  listSharingApplications,
} from "../services/resources/access.js";
import { listMemberApplications } from "../services/resources/apps.js";
import {
  assertActiveMember,
  assertCanManageGrants,
  assertCanManageResource,
  isPlatformAdmin,
} from "../services/resources/authority.js";
import {
  listActiveGrantCounts,
  listGrantsForResource,
  listGrantsForResources,
} from "../services/resources/grant-views.js";
import {
  createResourceGrant,
  getGrantForResource,
  revokeResourceGrant,
  updateResourceGrantPermission,
} from "../services/resources/grants.js";
import {
  activeMemberIdByEmail,
  resolveAudience,
} from "../services/resources/audience.js";
import { validateRelayDeclaration } from "../services/resources/gateway-declaration.js";
import { getUserIdentity } from "../services/usernames.js";
import { acceptResourceInvitation } from "../services/resources/invitations.js";
import { getUserActivity } from "../services/resources/monitoring.js";
import {
  createResource,
  getResource,
  listResourcesForOwner,
  markResourceValidated,
  removeResource,
  requestResourceValidation,
  updateResource,
} from "../services/resources/registry.js";
import { linkResourceToGatewayObject } from "../services/gateway-inventory.js";
import { buildSshValidationCommand } from "../services/ssh/targets.js";
import { getResourceScheme } from "../services/resources/scheme-service.js";
import { RESOURCE_SCHEME_RE } from "../services/resources/uri.js";
import {
  RESOURCE_PERMISSIONS,
  RESOURCE_SUBJECT_TYPES,
} from "../services/resources/types.js";
import { resourceMetadataSchema } from "./resource-metadata.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const resourceParamsSchema = z.object({ resourceId: z.string().uuid() });
const grantParamsSchema = resourceParamsSchema.extend({
  grantId: z.string().uuid(),
});
const invitationParamsSchema = z.object({ token: z.string().min(1).max(200) });

const accessibleQuerySchema = z
  .object({
    scheme: z.string().regex(RESOURCE_SCHEME_RE).optional(),
    applicationId: z.string().uuid().optional(),
  })
  .strict();

const activityQuerySchema = z
  .object({
    applicationId: z.string().uuid(),
    range: z.enum(["7d", "30d"]).default("7d"),
  })
  .strict();

const resourceAudienceSchema = z.union([
  z.object({ type: z.literal("everyone") }).strict(),
  z.object({ type: z.literal("plan"), planId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("organization"),
      organizationId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({ type: z.literal("user"), userId: z.string().min(1).max(128) })
    .strict(),
  z
    .object({
      type: z.literal("user"),
      email: z.string().trim().email().max(320),
    })
    .strict(),
]);

const resourceCreateSchema = z
  .object({
    applicationId: z.string().uuid(),
    scheme: z.string().regex(RESOURCE_SCHEME_RE),
    locator: z.string().trim().min(1).max(255).optional(),
    displayName: z.string().trim().min(1).max(200),
    metadata: resourceMetadataSchema.optional(),
    audience: resourceAudienceSchema.optional(),
  })
  .strict();

const resourcePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    listed: z.boolean().optional(),
    metadata: resourceMetadataSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

const grantCreateSchema = z
  .object({
    subjectType: z.enum(RESOURCE_SUBJECT_TYPES),
    subjectId: z.string().trim().min(1).max(256).nullable().optional(),
    // A user grant may name an e-mail instead of an id. auth-service resolves
    // it among the application's active members and gives the same answer for
    // an unknown address and a non-member, so the field cannot be used to
    // enumerate accounts.
    subjectEmail: z.string().trim().email().max(320).optional(),
    permission: z.enum(RESOURCE_PERMISSIONS).optional(),
    expiresAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value))
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.subjectType === "everyone") {
      if (value.subjectId !== undefined && value.subjectId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["subjectId"],
          message: "everyone has no subject id",
        });
      }
      if (value.subjectEmail !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["subjectEmail"],
          message: "everyone has no e-mail",
        });
      }
      return;
    }
    if (value.subjectType === "user" && value.subjectEmail !== undefined) {
      if (value.subjectId !== undefined && value.subjectId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["subjectId"],
          message: "Give either a subject id or a subject e-mail",
        });
      }
      return;
    }
    if (value.subjectEmail !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectEmail"],
        message: "Only a user grant accepts a subject e-mail",
      });
    }
    if (!value.subjectId) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectId"],
        message: "A subject id is required",
      });
    }
  });

const grantUpdateSchema = z
  .object({ permission: z.enum(RESOURCE_PERMISSIONS) })
  .strict();

const bulkShareSchema = z
  .object({
    resourceIds: z.array(z.string().uuid()).min(1).max(BULK_SHARE_LIMIT),
    applicationSlug: z.string().trim().min(1).max(256),
    permission: z.enum(RESOURCE_PERMISSIONS).optional(),
    expiresAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value))
      .nullable()
      .optional(),
  })
  .strict();

function publicResource(
  resource: Awaited<ReturnType<typeof getResource>>,
  scheme: Awaited<ReturnType<typeof getResourceScheme>>,
) {
  return {
    id: resource.id,
    applicationId: resource.applicationId,
    applicationSlug: resource.applicationSlug,
    applicationName: resource.applicationName,
    scheme: resource.scheme,
    schemeDisplayName: scheme?.displayName ?? resource.scheme,
    uri: resource.uri,
    displayName: resource.displayName,
    ownerType: resource.ownerType,
    ownerId: resource.ownerId,
    status: resource.status,
    listed: resource.listed,
    validationRequestedAt: resource.validationRequestedAt,
    validatedAt: resource.validatedAt,
    validationError: resource.validationError,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

interface ResourceCaller {
  userId: string;
  // The calling application for a bearer token, null for the auth-service UI.
  application: CallerApplication | null;
}

/**
 * A bearer token is confined to the application of its client: the UI session
 * sees the user's resources everywhere, a client sees its own application only.
 */
async function requireResourceCaller(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<ResourceCaller | null> {
  const caller = await requireUserOrBearerCaller(
    req,
    reply,
    RESOURCE_SELF_SCOPE,
  );
  if (!caller) return null;
  if (caller.clientId === null) {
    return { userId: caller.userId, application: null };
  }
  const application = await loadSharingApplicationBySlug(caller.clientId);
  if (!application) {
    throw ERR.AUTH_011(
      "The client is not an application with resource sharing enabled",
    );
  }
  return {
    userId: caller.userId,
    application: { id: application.id, slug: application.slug },
  };
}

function assertInCallerApplication(
  caller: ResourceCaller,
  applicationId: string,
): void {
  if (caller.application && caller.application.id !== applicationId) {
    throw ERR.RES_002();
  }
}

async function getResourceInScope(caller: ResourceCaller, resourceId: string) {
  const resource = await getResource(resourceId);
  assertInCallerApplication(caller, resource.applicationId);
  return resource;
}

export async function userResourceRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/accessible-resources",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const caller = await requireResourceCaller(req, reply);
      if (!caller) return;
      const { userId } = caller;
      const query = accessibleQuerySchema.parse(req.query);
      const resources = await listAccessibleResources({
        subjectId: userId,
        scheme: query.scheme,
        caller: caller.application ?? undefined,
      });
      await reply.send({
        resources: query.applicationId
          ? resources.filter((r) => r.applicationId === query.applicationId)
          : resources,
      });
    },
  );

  fastify.get(
    "/resource-catalogue",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const caller = await requireResourceCaller(req, reply);
      if (!caller) return;
      const { userId } = caller;
      const [resources, applications] = await Promise.all([
        listAccessibleResources({
          subjectId: userId,
          caller: caller.application ?? undefined,
        }),
        listSharingApplications(),
      ]);
      await reply.send({
        applications,
        resources,
        enabledSchemes: config.resources.enabledSchemes,
      });
    },
  );

  fastify.get("/resource-applications", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const applications = await listMemberApplications(userId);
    await reply.send({
      applications: caller.application
        ? applications.filter((app) => app.id === caller.application?.id)
        : applications,
    });
  });

  fastify.get("/resource-activity", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const query = activityQuerySchema.parse(req.query);
    assertInCallerApplication(caller, query.applicationId);
    await assertActiveMember(userId, query.applicationId);
    await reply.send(
      await getUserActivity(userId, query.applicationId, query.range),
    );
  });

  fastify.get("/resources", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const query = z
      .object({ include: z.enum(["grants"]).optional() })
      .parse(req.query);
    const resources = (await listResourcesForOwner("user", userId)).filter(
      (resource) =>
        !caller.application || resource.applicationId === caller.application.id,
    );
    const resourceIds = resources.map((resource) => resource.id);
    const [counts, grants] = await Promise.all([
      listActiveGrantCounts(resourceIds),
      query.include === "grants"
        ? listGrantsForResources(resourceIds)
        : Promise.resolve([]),
    ]);
    const grantsByResource = new Map<string, typeof grants>();
    for (const grant of grants) {
      const list = grantsByResource.get(grant.resourceId) ?? [];
      list.push(grant);
      grantsByResource.set(grant.resourceId, list);
    }
    await reply.send({
      resources: resources.map((resource) => ({
        ...resource,
        grantCount: counts.get(resource.id) ?? 0,
        ...(query.include === "grants"
          ? { grants: grantsByResource.get(resource.id) ?? [] }
          : {}),
      })),
    });
  });

  fastify.post("/resources", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const body = resourceCreateSchema.parse(req.body);
    assertInCallerApplication(caller, body.applicationId);
    await assertActiveMember(userId, body.applicationId);
    const audience = body.audience
      ? await resolveAudience(body.audience, body.applicationId)
      : null;
    let resource = await createResource({
      applicationId: body.applicationId,
      scheme: body.scheme,
      locator: body.locator ?? null,
      displayName: body.displayName,
      ownerType: "user",
      ownerId: userId,
      metadata: body.metadata,
    });
    if (audience) {
      try {
        await createResourceGrant({
          resourceId: resource.id,
          subjectType: audience.subjectType,
          subjectId: audience.subjectId,
          actorUserId: userId,
        });
      } catch (err) {
        // The grant is refused by policy: never leave a half-declared resource behind.
        await removeResource(resource.id, userId);
        throw err;
      }
    }
    const identity = await getUserIdentity(userId);
    resource = await validateRelayDeclaration(
      resource,
      identity?.username ?? null,
    );
    const scheme = await getResourceScheme(resource.scheme);
    await reply
      .status(201)
      .send({ resource: publicResource(resource, scheme) });
  });

  fastify.get("/resources/:resourceId", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const resource = await getResourceInScope(caller, resourceId);
    await assertCanManageResource(userId, resource);
    const scheme = await getResourceScheme(resource.scheme);
    await reply.send({ resource: publicResource(resource, scheme) });
  });

  fastify.patch("/resources/:resourceId", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const body = resourcePatchSchema.parse(req.body);
    await getResourceInScope(caller, resourceId);
    const resource = await updateResource(resourceId, userId, body);
    const scheme = await getResourceScheme(resource.scheme);
    await reply.send({ resource: publicResource(resource, scheme) });
  });

  fastify.delete("/resources/:resourceId", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    await getResourceInScope(caller, resourceId);
    const { resource, removed } = await removeResource(resourceId, userId);
    const scheme = await getResourceScheme(resource.scheme);
    await reply.send({ resource: publicResource(resource, scheme), removed });
  });

  fastify.post(
    "/resources/:resourceId/validation-request",
    async (req, reply) => {
      const caller = await requireResourceCaller(req, reply);
      if (!caller) return;
      const { userId } = caller;
      const { resourceId } = resourceParamsSchema.parse(req.params);
      await getResourceInScope(caller, resourceId);
      let resource = await requestResourceValidation(resourceId, userId);
      const scheme = await getResourceScheme(resource.scheme);
      if (
        resource.scheme === "llm" ||
        resource.scheme === "agent" ||
        resource.scheme === "mcp"
      ) {
        // The inventory is shared by every application: choosing which of its
        // objects an application may expose is a platform decision.
        if (!(await isPlatformAdmin(userId))) {
          throw ERR.AUTH_011(
            "Only a platform administrator validates a gateway resource",
          );
        }
        if (!(await linkResourceToGatewayObject(resource))) {
          throw ERR.RES_011("Resource is not present in the gateway inventory");
        }
        resource = await markResourceValidated(resource.id);
      }
      await reply.send({
        resource: publicResource(resource, scheme),
        validatorUrl:
          resource.status === "validated"
            ? null
            : (scheme?.validatorUrl ?? null),
        validationCommand:
          resource.status === "validated"
            ? null
            : buildSshValidationCommand(resource.id),
      });
    },
  );

  fastify.get("/resources/:resourceId/grants", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const resource = await getResourceInScope(caller, resourceId);
    await assertCanManageGrants(userId, resource);
    const grants = await listGrantsForResource(resourceId);
    await reply.send({ grants });
  });

  fastify.post("/resources/:resourceId/grants", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const { userId } = caller;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const body = grantCreateSchema.parse(req.body);
    const resource = await getResourceInScope(caller, resourceId);
    const subjectId =
      body.subjectType === "user" && body.subjectEmail
        ? await activeMemberIdByEmail(body.subjectEmail, resource.applicationId)
        : (body.subjectId ?? null);
    const grant = await createResourceGrant({
      resourceId,
      subjectType: body.subjectType,
      subjectId,
      actorUserId: userId,
      permission: body.permission,
      expiresAt: body.expiresAt ?? null,
    });
    await reply.status(201).send({ grant });
  });

  fastify.delete(
    "/resources/:resourceId/grants/:grantId",
    async (req, reply) => {
      const caller = await requireResourceCaller(req, reply);
      if (!caller) return;
      const { userId } = caller;
      const { resourceId, grantId } = grantParamsSchema.parse(req.params);
      await getResourceInScope(caller, resourceId);
      await getGrantForResource(grantId, resourceId);
      const grant = await revokeResourceGrant(grantId, userId);
      await reply.send({ grant });
    },
  );

  fastify.patch(
    "/resources/:resourceId/grants/:grantId",
    async (req, reply) => {
      const caller = await requireResourceCaller(req, reply);
      if (!caller) return;
      const { userId } = caller;
      const { resourceId, grantId } = grantParamsSchema.parse(req.params);
      const body = grantUpdateSchema.parse(req.body);
      await getGrantForResource(grantId, resourceId);
      const grant = await updateResourceGrantPermission(
        grantId,
        body.permission,
        userId,
      );
      await reply.send({ grant });
    },
  );

  fastify.post("/resource-shares", async (req, reply) => {
    const caller = await requireResourceCaller(req, reply);
    if (!caller) return;
    const body = bulkShareSchema.parse(req.body);
    for (const resourceId of body.resourceIds) {
      await getResourceInScope(caller, resourceId);
    }
    const results = await shareResourcesWithApplication({
      resourceIds: body.resourceIds,
      applicationSlug: body.applicationSlug,
      permission: body.permission,
      expiresAt: body.expiresAt ?? null,
      actorUserId: caller.userId,
    });
    await reply.send({ results });
  });

  fastify.post("/resource-invitations/accept", async (req, reply) => {
    // The invitation binds to the session e-mail, so a bearer token is not enough.
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
