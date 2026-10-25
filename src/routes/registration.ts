import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { completeRegistration } from "../services/registration-invitations.js";

// The email comes from the invitation row, never from the caller: an invitee
// must not be able to register a different address than the one the
// administrator vouched for.
const completeRegistrationSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200),
});

export async function registrationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Public: the token is the credential. Redeemed once, inside the service.
  fastify.post(
    "/complete",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = completeRegistrationSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid registration details");

      const result = await completeRegistration(parsed.data);
      return reply.send({ ok: true, email: result.email });
    },
  );
}
