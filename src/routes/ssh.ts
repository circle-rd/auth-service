import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../middleware.js";
import {
  createSshMetaUser,
  deleteSshMetaUser,
  getSshOwnerDetail,
  listSshMetaUsers,
  setupSshTarget,
} from "../services/ssh/targets.js";
import {
  listRecipientKeys,
  registerRecipientKey,
  revokeRecipientKey,
} from "../services/ssh/keys.js";
import { parseSshPublicKey } from "../services/ssh/crypto.js";
import { issueKeyChallenge } from "../services/ssh/key-proof.js";

const resourceParamsSchema = z.object({ resourceId: z.string().uuid() });
const metaUserParamsSchema = resourceParamsSchema.extend({
  metaUser: z.string().min(3).max(32),
});
const keyParamsSchema = z.object({ keyId: z.string().uuid() });

const targetSchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(22),
    account: z.string().trim().min(1).max(64),
  })
  .strict();
const metaUserSchema = z
  .object({ metaUser: z.string().trim().min(3).max(32) })
  .strict();
const publicKeySchema = z.string().trim().min(32).max(4096);
const challengeSchema = z.object({ publicKey: publicKeySchema }).strict();
const recipientKeySchema = z
  .object({
    publicKey: publicKeySchema,
    challenge: z.string().trim().min(1).max(256),
    signature: z.string().trim().min(1).max(4096),
    label: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export async function sshResourceRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.put("/resources/:resourceId/ssh-target", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const body = targetSchema.parse(req.body);
    await reply.send({
      ssh: await setupSshTarget(resourceId, userId, body),
    });
  });

  fastify.get("/resources/:resourceId/ssh-target", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    await reply.send({
      ssh: await getSshOwnerDetail(resourceId, userId),
    });
  });

  fastify.get("/resources/:resourceId/ssh/meta-users", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    await reply.send({
      metaUsers: await listSshMetaUsers(resourceId, userId),
    });
  });

  fastify.post("/resources/:resourceId/ssh/meta-users", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { resourceId } = resourceParamsSchema.parse(req.params);
    const body = metaUserSchema.parse(req.body);
    await reply.status(201).send({
      metaUser: await createSshMetaUser(resourceId, userId, body.metaUser),
    });
  });

  fastify.delete(
    "/resources/:resourceId/ssh/meta-users/:metaUser",
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;
      const { resourceId, metaUser } = metaUserParamsSchema.parse(req.params);
      await deleteSshMetaUser(resourceId, userId, metaUser);
      await reply.status(204).send();
    },
  );

  fastify.get("/recipient-keys", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    await reply.send({ keys: await listRecipientKeys(userId) });
  });

  fastify.post("/recipient-keys/challenge", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const body = challengeSchema.parse(req.body);
    await reply.send(
      issueKeyChallenge(userId, parseSshPublicKey(body.publicKey)),
    );
  });

  fastify.post("/recipient-keys", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const body = recipientKeySchema.parse(req.body);
    await reply.status(201).send({
      key: await registerRecipientKey(
        userId,
        body.publicKey,
        { challenge: body.challenge, signature: body.signature },
        body.label,
      ),
    });
  });

  fastify.delete("/recipient-keys/:keyId", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const { keyId } = keyParamsSchema.parse(req.params);
    await revokeRecipientKey(userId, keyId);
    await reply.status(204).send();
  });
}
