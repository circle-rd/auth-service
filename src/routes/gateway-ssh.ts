import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { assertSchemeValidator } from "../services/resources/scheme-service.js";
import { requireMachineScope } from "../services/machine-auth.js";
import { validateDeviceSession } from "../services/ssh/device.js";
import { resolveRecipientKeyUserId } from "../services/ssh/keys.js";
import {
  getSshGatewayDetail,
  recordSshSession,
  resolveSshTargetByMetaUser,
} from "../services/ssh/targets.js";
import { SSH_SESSION_END_REASONS } from "../db/ssh-schema.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const resourceParamsSchema = z.object({ resourceId: z.string().uuid() });
const targetQuerySchema = z
  .object({ metaUser: z.string().trim().min(3).max(32) })
  .strict();
const detailQuerySchema = z
  .object({ subjectId: z.string().trim().min(1).max(256).optional() })
  .strict();
const recipientKeyBodySchema = z
  .object({ publicKey: z.string().trim().min(32).max(4096) })
  .strict();
const deviceSessionBodySchema = z
  .object({ sessionToken: z.string().trim().min(1).max(512) })
  .strict();
const sessionBodySchema = z
  .object({
    resourceId: z.string().uuid(),
    resourceUri: z.string().trim().min(1).max(512),
    subjectId: z.string().trim().min(1).max(256),
    clientId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    startedAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value)),
    endedAt: z
      .string()
      .datetime()
      .transform((value) => new Date(value)),
    bytesIn: z.number().int().min(0).nullable(),
    bytesOut: z.number().int().min(0).nullable(),
    endReason: z.enum(SSH_SESSION_END_REASONS),
  })
  .strict();

export async function gatewaySshRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/ssh/targets",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(req.headers.authorization, "ssh:target:read");
      const query = targetQuerySchema.parse(req.query);
      await reply.send(await resolveSshTargetByMetaUser(query.metaUser));
    },
  );

  fastify.post(
    "/ssh/recipient-key",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(req.headers.authorization, "ssh:target:read");
      const body = recipientKeyBodySchema.parse(req.body);
      await reply.send({
        userId: await resolveRecipientKeyUserId(body.publicKey),
      });
    },
  );

  fastify.get(
    "/ssh/resources/:resourceId",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(req.headers.authorization, "ssh:resource:read");
      const { resourceId } = resourceParamsSchema.parse(req.params);
      const query = detailQuerySchema.parse(req.query);
      await reply.send(await getSshGatewayDetail(resourceId, query.subjectId));
    },
  );

  fastify.post(
    "/ssh/sessions",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const { clientId } = await requireMachineScope(
        req.headers.authorization,
        "resources:usage:write",
      );
      const body = sessionBodySchema.parse(req.body);
      if (body.clientId !== clientId) {
        throw ERR.AUTH_011("Session client id does not match the token");
      }
      await assertSchemeValidator("ssh", clientId);
      const result = await recordSshSession(body);
      await reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  fastify.post(
    "/device/session",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "device:session:validate",
      );
      const body = deviceSessionBodySchema.parse(req.body);
      const session = await validateDeviceSession(body.sessionToken);
      await reply.send({
        userId: session.userId,
        email: session.email,
        expiresAt: session.expiresAt.toISOString(),
      });
    },
  );
}
