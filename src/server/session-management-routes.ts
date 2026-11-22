import { type FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth.js";
import {
  checkSessionIframeHtml,
  checkSessionState,
  createSessionState,
} from "../services/session-management.js";
import { ERR } from "../errors.js";

export function registerSessionManagementRoutes(
  fastify: FastifyInstance,
): void {
  // ── OIDC Session Management ─────────────────────────────────────
  // The iframe is loaded by the relying party's origin, so it must not carry
  // the SAMEORIGIN / frame-ancestors=none headers applied to every other route.
  const SESSION_IFRAME_ROUTE_OPTIONS = {
    helmet: {
      frameguard: false,
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: false,
    },
  };

  fastify.get(
    "/check_session_iframe",
    SESSION_IFRAME_ROUTE_OPTIONS,
    async (_req, reply) =>
      reply
        .header(
          "content-security-policy",
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors *;",
        )
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(checkSessionIframeHtml()),
  );

  fastify.get("/check_session_state", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const clientId = query.client_id;
    const origin = query.origin;
    const sessionState =
      typeof query.session_state === "string" ? query.session_state : undefined;
    if (!clientId || !origin || !sessionState) {
      return reply
        .header("cache-control", "no-store")
        .send({ status: "error" });
    }
    let currentSessionId: string | null;
    try {
      const current = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      currentSessionId = current?.session?.id ?? null;
    } catch {
      // An unreadable cookie means no current OP session: the state is stale.
      currentSessionId = null;
    }
    return reply.header("cache-control", "no-store").send({
      status: await checkSessionState(
        clientId,
        origin,
        sessionState,
        currentSessionId,
      ),
    });
  });

  // Internal resume paths (sign-in, MFA verification) return the client
  // redirect directly and bypass the authorize route that adds `session_state`.
  // The login page asks for the same signed value here before navigating.
  fastify.get("/api/session-state", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const clientId = query.client_id;
    const redirectUri = query.redirect_uri;
    if (!clientId || !redirectUri) {
      throw ERR.AUTH_012("client_id and redirect_uri are required");
    }
    let origin: string;
    try {
      origin = new URL(redirectUri).origin;
    } catch {
      throw ERR.AUTH_012("redirect_uri is not a valid URL");
    }
    const current = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    return reply.header("cache-control", "no-store").send({
      session_state: current?.session?.id
        ? createSessionState(current.session.id, clientId, origin)
        : null,
    });
  });
}
