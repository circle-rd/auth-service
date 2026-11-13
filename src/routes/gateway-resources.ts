import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMachineScope } from "../services/machine-auth.js";
import { RESOURCE_TYPES } from "../services/resource-uri.js";
import { listAccessibleResources } from "../services/resource-sharing/accessible.js";
import { authorize } from "../services/resource-sharing/policy.js";
import {
  recordUsageEvent,
  USAGE_SOURCES,
} from "../services/resource-sharing/usage.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const authorizeBodySchema = z.object({
  subjectId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  resourceType: z.enum(RESOURCE_TYPES),
  key: z.string().min(1).max(512),
  audience: z.string().min(1).max(2048),
  requestId: z.string().min(1).max(256),
});

const grossCostSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/, "must be a plain decimal");

const usageBodySchema = z
  .object({
    subjectId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    resourceId: z.string().uuid(),
    resourceType: z.enum(RESOURCE_TYPES),
    resourceKey: z.string().min(1).max(512),
    planName: z.string().min(1).max(200),
    requestId: z.string().regex(/^[a-f0-9]{64}$/, "must be a trusted event id"),
    occurredAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value)),
    usageSource: z.enum(USAGE_SOURCES),
    costUsd: grossCostSchema.nullable(),
    promptTokens: z.number().int().min(0).nullable(),
    completionTokens: z.number().int().min(0).nullable(),
    totalTokens: z.number().int().min(0).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const now = Date.now();
    if (
      value.occurredAt.getTime() > now + 5 * 60_000 ||
      value.occurredAt.getTime() < now - 30 * 24 * 60 * 60_000
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["occurredAt"],
        message: "occurredAt is outside the accepted accounting window",
      });
    }
    const tokens = [
      value.promptTokens,
      value.completionTokens,
      value.totalTokens,
    ];
    if (value.usageSource === "unsupported") {
      if (value.costUsd !== null || tokens.some((t) => t !== null)) {
        ctx.addIssue({
          code: "custom",
          message: "unsupported usage must not carry cost or tokens",
        });
      }
      return;
    }
    if (value.costUsd === null) {
      ctx.addIssue({
        code: "custom",
        path: ["costUsd"],
        message: "provider usage requires a reported cost",
      });
    }
  });

const accessibleQuerySchema = z.object({
  subjectId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  resourceType: z.enum(RESOURCE_TYPES),
  audience: z.string().min(1).max(2048),
});

/**
 * Machine-scoped endpoints the gateway calls per request. Mounted only when
 * RESOURCE_SHARING_ENABLED is on, so the flag-off deployment has no new route.
 */
export async function gatewayResourceRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/authorize",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "resources:authorize",
      );
      const body = authorizeBodySchema.parse(req.body);
      const decision = await authorize({
        subjectId: body.subjectId,
        clientId: body.clientId,
        resourceType: body.resourceType,
        key: body.key,
        audience: body.audience,
      });
      if (decision.decision === "deny") {
        await reply.send({ decision: "deny" });
        return;
      }
      await reply.send({
        decision: "allow",
        ownerApplicationSlug: decision.ownerApplicationSlug,
        planName: decision.planName,
        teamId: decision.teamId,
        resourceId: decision.resourceId,
      });
    },
  );

  fastify.post(
    "/usage",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "resources:usage:write",
      );
      const body = usageBodySchema.parse(req.body);
      const { record, replayed } = await recordUsageEvent({
        subjectId: body.subjectId,
        clientId: body.clientId,
        resourceId: body.resourceId,
        resourceType: body.resourceType,
        resourceKey: body.resourceKey,
        planName: body.planName,
        requestId: body.requestId,
        occurredAt: body.occurredAt,
        usageSource: body.usageSource,
        costUsd: body.costUsd,
        promptTokens: body.promptTokens,
        completionTokens: body.completionTokens,
        totalTokens: body.totalTokens,
      });
      req.log.info(
        {
          ownerApplicationId: record.ownerApplicationId,
          resourceId: record.resourceId,
          resourceType: record.resourceType,
          usageSource: record.usageSource,
          replayed,
        },
        "gateway usage recorded",
      );
      await reply.status(replayed ? 200 : 201).send({
        usage: {
          id: record.id,
          resourceId: record.resourceId,
          requestId: record.requestId,
          occurredAt: record.occurredAt.toISOString(),
        },
        replayed,
      });
    },
  );

  fastify.get(
    "/resources/accessible",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "resources:authorize",
      );
      const query = accessibleQuerySchema.parse(req.query);
      const resources = await listAccessibleResources(query);
      await reply.send({ resources });
    },
  );
}
