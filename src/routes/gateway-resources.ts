import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMachineScope } from "../services/machine-auth.js";
import { listAccessibleResources } from "../services/resources/access.js";
import {
  authorize,
  type AccessDecision,
} from "../services/resources/policy.js";
import {
  recordAccessEvent,
  recordUsageEvent,
} from "../services/resources/usage.js";
import {
  RESOURCE_EVENT_SOURCES,
  RESOURCE_USAGE_SOURCES,
} from "../services/resources/types.js";
import {
  completeResourceValidation,
  invalidateResource,
  VALIDATION_RESULTS,
} from "../services/resources/validation.js";
import { RESOURCE_SCHEME_RE } from "../services/resources/uri.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const resourceParamsSchema = z.object({ resourceId: z.string().uuid() });

const authorizeBodySchema = z
  .object({
    subjectId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    resourceUri: z.string().min(3).max(512),
    audience: z.string().min(1).max(2048),
    requestId: z.string().min(1).max(256).optional(),
    source: z.enum(RESOURCE_EVENT_SOURCES).optional(),
  })
  .strict();

const accessibleQuerySchema = z
  .object({
    subjectId: z.string().min(1).max(256),
    scheme: z.string().regex(RESOURCE_SCHEME_RE).optional(),
  })
  .strict();

const grossCostSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/, "must be a plain decimal");

const usageBodySchema = z
  .object({
    subjectId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    resourceId: z.string().uuid(),
    resourceUri: z.string().min(3).max(512),
    requestId: z.string().regex(/^[a-f0-9]{64}$/, "must be a trusted event id"),
    occurredAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value)),
    usageSource: z.enum(RESOURCE_USAGE_SOURCES),
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

const validateBodySchema = z
  .object({
    result: z.enum(VALIDATION_RESULTS),
    reason: z.string().trim().max(500).nullable().optional(),
    evidence: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const invalidateBodySchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

function schemeOf(uri: string): string {
  const separator = uri.indexOf("://");
  return separator > 0 ? uri.slice(0, separator).slice(0, 50) : "unknown";
}

async function logDecision(
  decision: AccessDecision,
  input: {
    uri: string;
    subjectId: string;
    clientId: string;
    requestId?: string;
    source?: (typeof RESOURCE_EVENT_SOURCES)[number];
  },
): Promise<void> {
  if (decision.decision === "allow") {
    await recordAccessEvent({
      resourceId: decision.resourceId,
      uri: decision.resourceUri,
      scheme: decision.scheme,
      ownerType: decision.ownerType,
      ownerId: decision.ownerId,
      subjectType: "user",
      subjectId: input.subjectId,
      clientId: input.clientId,
      applicationId: decision.applicationId,
      decision: "allow",
      reasonClass: decision.accessKind,
      requestId: input.requestId,
      source: input.source ?? "gateway",
    });
    return;
  }
  await recordAccessEvent({
    uri: input.uri,
    scheme: schemeOf(input.uri),
    subjectType: "user",
    subjectId: input.subjectId,
    clientId: input.clientId,
    decision: "deny",
    reasonClass: decision.reason,
    requestId: input.requestId,
    source: input.source ?? "gateway",
  });
}

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
        resourceUri: body.resourceUri,
        audience: body.audience,
      });
      try {
        await logDecision(decision, {
          uri: body.resourceUri,
          subjectId: body.subjectId,
          clientId: body.clientId,
          requestId: body.requestId,
          source: body.source,
        });
      } catch (err) {
        req.log.warn({ err }, "[res] access event could not be recorded");
      }
      if (decision.decision === "deny") {
        await reply.send({ decision: "deny" });
        return;
      }
      await reply.send({
        decision: "allow",
        resourceId: decision.resourceId,
        resourceUri: decision.resourceUri,
        applicationSlug: decision.applicationSlug,
        ownerType: decision.ownerType,
        ownerId: decision.ownerId,
        accessKind: decision.accessKind,
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
      const resources = await listAccessibleResources({
        subjectId: query.subjectId,
        scheme: query.scheme,
      });
      await reply.send({ resources });
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
        resourceUri: body.resourceUri,
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
          resourceId: record.resourceId,
          scheme: record.scheme,
          usageSource: record.usageSource,
          replayed,
        },
        "resource usage recorded",
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

  fastify.post(
    "/resources/:resourceId/validate",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const { clientId } = await requireMachineScope(
        req.headers.authorization,
        "resources:validate",
      );
      const { resourceId } = resourceParamsSchema.parse(req.params);
      const body = validateBodySchema.parse(req.body);
      const resource = await completeResourceValidation({
        resourceId,
        clientId,
        result: body.result,
        reason: body.reason,
        evidence: body.evidence,
      });
      await reply.send({
        resource: {
          id: resource.id,
          uri: resource.uri,
          status: resource.status,
          validationError: resource.validationError,
        },
      });
    },
  );

  fastify.post(
    "/resources/:resourceId/invalidate",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const { clientId } = await requireMachineScope(
        req.headers.authorization,
        "resources:validate",
      );
      const { resourceId } = resourceParamsSchema.parse(req.params);
      const body = invalidateBodySchema.parse(req.body);
      const resource = await invalidateResource({
        resourceId,
        clientId,
        reason: body.reason,
      });
      await reply.send({
        resource: {
          id: resource.id,
          uri: resource.uri,
          status: resource.status,
          validationError: resource.validationError,
        },
      });
    },
  );
}
