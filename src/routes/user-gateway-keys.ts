import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RESOURCE_SELF_SCOPE } from "../compat/scopes.js";
import { ERR } from "../errors.js";
import { requireUserOrBearerCaller, type UserCaller } from "../middleware.js";
import {
  createGatewayKey,
  listActiveGatewayKeys,
  revokeGatewayKey,
} from "../services/gateway-keys.js";
import {
  loadSharingApplicationBySlug,
  type SharingApplication,
} from "../services/resources/application-scope.js";

const createGatewayKeySchema = z
  .object({
    label: z.string().min(1).max(80),
    organizationId: z.string().min(1).max(128).optional(),
  })
  .strict();

const keyParamsSchema = z.object({ keyId: z.string().uuid() }).strict();

async function requireConsumerApplication(
  caller: UserCaller,
): Promise<SharingApplication> {
  if (caller.clientId === null) {
    throw ERR.KEY_004("Gateway keys are managed by a consumer application");
  }
  const application = await loadSharingApplicationBySlug(caller.clientId);
  if (application === null) {
    throw ERR.KEY_004(
      "The caller is not an application with resource sharing enabled",
    );
  }
  return application;
}

export async function userGatewayKeyRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/gateway-keys", async (req, reply) => {
    const caller = await requireUserOrBearerCaller(
      req,
      reply,
      RESOURCE_SELF_SCOPE,
    );
    if (!caller) return;
    const application = await requireConsumerApplication(caller);
    await reply.send({
      keys: await listActiveGatewayKeys(caller.userId, application.id),
    });
  });

  fastify.post("/gateway-keys", async (req, reply) => {
    const caller = await requireUserOrBearerCaller(
      req,
      reply,
      RESOURCE_SELF_SCOPE,
    );
    if (!caller) return;
    const parsed = createGatewayKeySchema.safeParse(req.body);
    if (!parsed.success) throw ERR.KEY_003();
    const application = await requireConsumerApplication(caller);
    const created = await createGatewayKey({
      userId: caller.userId,
      application: { id: application.id, slug: application.slug },
      organizationId: parsed.data.organizationId ?? null,
      label: parsed.data.label,
    });
    await reply.header("Cache-Control", "no-store").status(201).send({
      id: created.id,
      label: created.label,
      organizationId: created.organizationId,
      maskedKey: created.maskedKey,
      key: created.key,
      createdAt: created.createdAt,
    });
  });

  fastify.delete("/gateway-keys/:keyId", async (req, reply) => {
    const caller = await requireUserOrBearerCaller(
      req,
      reply,
      RESOURCE_SELF_SCOPE,
    );
    if (!caller) return;
    const parsed = keyParamsSchema.safeParse(req.params);
    if (!parsed.success) throw ERR.KEY_003();
    const application = await requireConsumerApplication(caller);
    await revokeGatewayKey(caller.userId, parsed.data.keyId, application.id);
    await reply.status(204).send();
  });
}
