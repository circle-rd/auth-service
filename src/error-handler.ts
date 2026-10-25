import type { FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth";
import { ZodError } from "zod";
import { ApiError } from "./errors.js";
import { config } from "./config.js";
import { renderAuthPage } from "./services/templates.js";

/**
 * Only browser navigations get the HTML error page. API/AJAX callers (anything
 * under `/api/`, plus requests that do not accept HTML) keep the JSON envelope
 * they rely on.
 */
function wantsHtml(req: FastifyRequest): boolean {
  if (req.url.startsWith("/api/")) return false;
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function errorStatus(error: unknown): number {
  if (error instanceof ApiError) return error.statusCode;
  if (error instanceof ZodError) return 400;
  if (error instanceof APIError) {
    return (
      error.statusCode ??
      (typeof error.status === "number" ? error.status : 500)
    );
  }
  const err = error as { validation?: unknown; statusCode?: unknown };
  if (err.validation) return 400;
  if (
    typeof err.statusCode === "number" &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  ) {
    return err.statusCode;
  }
  return 500;
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof ZodError) return "APP_001";
  if (error instanceof APIError) {
    const body = error.body as { code?: string } | undefined;
    return body?.code ?? "AUTH_001";
  }
  return "SRV_001";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof ZodError) return "Validation error";
  if (error instanceof APIError) {
    const body = error.body as { message?: string } | undefined;
    return body?.message ?? error.message;
  }
  return "Internal server error";
}

/**
 * Render the templated error page for a browser navigation. Returns false when
 * the page does not apply (no `TEMPLATES_DIR`, not an HTML request) or cannot be
 * rendered, so the caller falls back to the JSON envelope.
 */
async function tryRenderHtmlError(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): Promise<boolean> {
  if (!config.templatesDir || !wantsHtml(req)) return false;
  try {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const appSlug = typeof query.client_id === "string" ? query.client_id : "";
    const html = renderAuthPage(
      "error",
      {
        actionUrl: "",
        redirectTo: "",
        appSlug,
        authUrl: config.betterAuth.url,
        appName: config.appName,
        logoUrl: config.appLogoUrl ?? "",
        logoDarkUrl: config.appLogoDarkUrl ?? "",
        errorCode: errorCode(error),
        errorDescription: errorMessage(error),
        loginUrl: "/login",
      },
      appSlug || null,
      config.templatesDir,
    );
    await reply
      .status(errorStatus(error))
      .header("content-type", "text/html; charset=utf-8")
      .send(html);
    return true;
  } catch {
    // A broken override must never hide the real error from the caller.
    return false;
  }
}

/**
 * Serialise every error a route can throw into the documented
 * `{ error: { code, message, details? } }` envelope. Browser navigations to a
 * non-API path get the templated error page instead when templates are enabled.
 */
export async function globalErrorHandler(
  error: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (await tryRenderHtmlError(req, reply, error)) return;

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
