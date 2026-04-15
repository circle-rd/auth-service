/**
 * Creates a Fastify test instance with the ApiError global error handler
 * pre-registered.  Import this instead of `Fastify()` in integration tests.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { ApiError } from "../../errors.js";

export function createTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler(async (error, _req, reply) => {
    if (error instanceof ApiError) {
      await reply.status(error.statusCode).send(error.toJSON());
      return;
    }
    await reply.status(500).send({
      error: { code: "SRV_001", message: error.message },
    });
  });

  return app;
}
