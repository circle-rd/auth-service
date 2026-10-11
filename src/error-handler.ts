import type { FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth";
import { ZodError } from "zod";
import { ApiError } from "./errors.js";

/**
 * Serialise every error a route can throw into the documented
 * `{ error: { code, message, details? } }` envelope.
 */
export async function globalErrorHandler(
  error: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (error instanceof ApiError) {
    await reply.status(error.statusCode).send(error.toJSON());
    return;
  }

  // Zod validation errors from route handlers map to 400 without leaking the
  // raw stack.
  if (error instanceof ZodError) {
    await reply.status(400).send({
      error: {
        code: "APP_001",
        message: "Validation error",
        details: error.flatten(),
      },
    });
    return;
  }

  // BetterAuth throws APIError with an HTTP status and a sanitised body.
  if (error instanceof APIError) {
    const status =
      error.statusCode ??
      (typeof error.status === "number" ? error.status : 500);
    const body = error.body as { code?: string; message?: string } | undefined;
    await reply.status(status).send({
      error: {
        code: body?.code ?? "AUTH_001",
        message: body?.message ?? error.message,
      },
    });
    return;
  }

  const err = error as { validation?: unknown; statusCode?: unknown };
  if (err.validation) {
    await reply.status(400).send({
      error: {
        code: "APP_001",
        message: "Validation error",
        details: err.validation,
      },
    });
    return;
  }

  // Framework HTTP errors (rate limit, malformed JSON, ...) keep Fastify's
  // default serialisation and status.
  if (
    typeof err.statusCode === "number" &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  ) {
    await reply.send(error);
    return;
  }

  req.log.error(error);
  await reply.status(500).send({
    error: { code: "SRV_001", message: "Internal server error" },
  });
}
