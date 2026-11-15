import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { getRequestSession, requireSession } from "../middleware.js";
import {
  listAccessibleResources,
  listSharingApplications,
} from "../services/resources/access.js";
import { listMemberApplications } from "../services/resources/apps.js";
import {
  assertActiveMember,
  assertCanManageResource,
} from "../services/resources/authority.js";
import {
  createResourceGrant,
  getGrantForResource,
  listGrantsForResource,
  revokeResourceGrant,
} from "../services/resources/grants.js";
import { acceptResourceInvitation } from "../services/resources/invitations.js";
import {
  createResource,
  disableResource,
  getResource,
  listResourcesForOwner,
  markResourceValidated,
  requestResourceValidation,
  updateResource,
} from "../services/resources/registry.js";
import { linkResourceToGatewayObject } from "../services/gateway-inventory.js";
import { getResourceScheme } from "../services/resources/scheme-service.js";
import { RESOURCE_SCHEME_RE } from "../services/resources/uri.js";
import { RESOURCE_SUBJECT_TYPES } from "../services/resources/types.js";

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

const resourceCreateSchema = z
  .object({
    applicationId: z.string().uuid(),
    scheme: z.string().regex(RESOURCE_SCHEME_RE),
    locator: z.string().trim().min(1).max(255).optional(),
    displayName: z.string().trim().min(1).max(200),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const resourcePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    listed: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

const grantCreateSchema = z
  .object({
    subjectType: z.enum(RESOURCE_SUBJECT_TYPES),
    subjectId: z.string().trim().min(1).max(256).nullable().optional(),
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
      return;
    }
    if (!value.subjectId) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectId"],
        message: "A subject id is required",
      });
    }
  });

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
      const resources = await listAccessibleResources({
        subjectId: userId,
        scheme: query.scheme,
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
      const userId = await requireSession(req, reply);
      if (!userId) return;
      const [resources, applications] = await Promise.all([
        listAccessibleResources({ subjectId: userId }),
        listSharingApplications(),
      ]);
      await reply.send({ applications, resources });
    },
  );

  fastify.get("/resource-applications", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    await reply.send({ applications: await listMemberApplications(userId) });
  });

  fastify.get("/resources", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const resources = await listResourcesForOwner("user", userId);
    await reply.send({ resources });
  });

  fastify.post("/resources", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const body = resourceCreateSchema.parse(req.body);
    await assertActiveMember(userId, body.applicationId);
    const resource = await createResource({
      applicationId: body.applicationId,
      scheme: body.scheme,
      locator: body.locator ?? null,
      displayName: body.displayName,
      ownerType: "user",
      ownerId: userId,
      metadata: body.metadata,
    });
    const scheme = await getResourceScheme(resource.scheme);
    await reply
      .status(201)
      .send({ resource: publicResource(resource, scheme) });
  });

  fastify.get("/resources/:resourceId", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const resource = await getResource(resourceId);
    await assertCanManageResource(userId, resource);
    const scheme = await getResourceScheme(resource.scheme);
    await reply.send({ resource: publicResource(resource, scheme) });
  });

  fastify.patch("/resources/:resourceId", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const body = resourcePatchSchema.parse(req.body);
    const resource = await updateResource(resourceId, userId, body);
    const scheme = await getResourceScheme(resource.scheme);
    await reply.send({ resource: publicResource(resource, scheme) });
  });

  fastify.delete("/resources/:resourceId", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const resource = await disableResource(resourceId, userId);
    const scheme = await getResourceScheme(resource.scheme);
    await reply.send({ resource: publicResource(resource, scheme) });
  });

  fastify.post(
    "/resources/:resourceId/validation-request",
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;
      const { resourceId } = resourceParamsSchema.parse(req.params);
      let resource = await requestResourceValidation(resourceId, userId);
      const scheme = await getResourceScheme(resource.scheme);
      if (
        resource.scheme === "llm" ||
        resource.scheme === "agent" ||
        resource.scheme === "mcp"
      ) {
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
      });
    },
  );

  fastify.get("/resources/:resourceId/grants", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const resource = await getResource(resourceId);
    await assertCanManageResource(userId, resource);
    const grants = await listGrantsForResource(resourceId);
    await reply.send({ grants });
  });

  fastify.post("/resources/:resourceId/grants", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const body = grantCreateSchema.parse(req.body);
    const grant = await createResourceGrant({
      resourceId,
      subjectType: body.subjectType,
      subjectId: body.subjectId ?? null,
      actorUserId: userId,
      expiresAt: body.expiresAt ?? null,
    });
    await reply.status(201).send({ grant });
  });

  fastify.delete(
    "/resources/:resourceId/grants/:grantId",
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;
      const { resourceId, grantId } = grantParamsSchema.parse(req.params);
      await getGrantForResource(grantId, resourceId);
      const grant = await revokeResourceGrant(grantId, userId);
      await reply.send({ grant });
    },
  );

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
