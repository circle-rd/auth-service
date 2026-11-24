import { type FastifyInstance, type FastifyReply } from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";

export function createSpaFallback(
  fastify: FastifyInstance,
  frontendDist: string,
) {
  // Server-rendered auth pages fall back to the Vue SPA when a template cannot
  // be rendered. Surface the reason: otherwise a broken or missing override
  // silently serves the SPA design and the misconfiguration goes unnoticed.
  // Only the page name, slug and error message are logged (never the request
  // URL or query string, which can carry tokens).
  function sendSpaFallback(
    reply: FastifyReply,
    page: string,
    appSlug: string | null,
    err: unknown,
  ) {
    fastify.log.warn(
      { page, appSlug, err: err instanceof Error ? err.message : String(err) },
      "[templates] auth page template failed to render; serving the SPA instead",
    );
    if (existsSync(frontendDist)) {
      return reply.sendFile("index.html", frontendDist);
    }
    return reply.callNotFound();
  }
  return sendSpaFallback;
}

export type SpaFallback = ReturnType<typeof createSpaFallback>;

export async function registerStaticFrontend(
  fastify: FastifyInstance,
  frontendDist: string,
): Promise<void> {
  if (existsSync(frontendDist)) {
    await fastify.register(staticFiles, {
      root: frontendDist,
      prefix: "/",
      wildcard: false,
    });
  }
}

export function registerSpaNotFound(
  fastify: FastifyInstance,
  frontendDist: string,
): void {
  // ── SPA fallback ────────────────────────────────────────────────
  // Asset-shaped paths (file extension or under /assets/) return 404;
  // extensionless paths get the SPA shell so client-side routing works.
  function isAssetPath(url: string): boolean {
    const path = url.split("?")[0] ?? "";
    if (path.startsWith("/assets/")) return true;
    const segments = path.split("/");
    const last = segments[segments.length - 1];
    return last.includes(".");
  }

  fastify.setNotFoundHandler(async (req, reply) => {
    // The shell answers navigations only. An unknown POST, PUT or DELETE is an
    // API miss: answering it with the HTML page would hide the error.
    const navigation = req.method === "GET" || req.method === "HEAD";
    if (
      navigation &&
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/api/auth/") &&
      // Discovery clients read these paths for a document: an HTML page would
      // read as a malformed answer, a 404 as "not offered".
      !req.url.startsWith("/.well-known/") &&
      existsSync(frontendDist) &&
      !isAssetPath(req.url)
    ) {
      return reply.sendFile("index.html", frontendDist);
    }
    await reply
      .status(404)
      .send({ error: { code: "SRV_001", message: "Not found" } });
  });
}
