/**
 * Creates a Fastify test instance with the production global error handler
 * pre-registered.  Import this instead of `Fastify()` in integration tests.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { globalErrorHandler } from "../../error-handler.js";

export function createTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler(globalErrorHandler);
  return app;
}
