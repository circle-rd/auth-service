import { type FastifyInstance } from "fastify";
import {
  oauthProviderOpenIdConfigMetadata,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";
import { config } from "../config.js";
import { auth } from "../auth.js";

export function registerDiscoveryRoutes(fastify: FastifyInstance): void {
  // ── OIDC / OAuth 2.0 discovery at root ──────────────────────────
  const handleOpenIdConfig = oauthProviderOpenIdConfigMetadata(auth);
  const handleAuthServerMeta = oauthProviderAuthServerMetadata(auth);

  // Both documents are public metadata (RFC 8414 §3.1, OpenID Connect Discovery
  // §4) that a client application's browser fetches *before* any credential
  // exists, so there is no origin to scope them to: a client whose origin has
  // not been registered yet still has to resolve the issuer. Per-route CORS
  // overrides below serve them with `Access-Control-Allow-Origin: *` and never
  // with credentials, and drop the CORP header helmet adds to every other
  // response, which would otherwise contradict that. `CORS_ORIGINS` keeps
  // governing every authenticated route; nothing else is widened.
  const DISCOVERY_ROUTE_OPTIONS = {
    // Read by @fastify/cors' onRequest hook in place of the global options.
    config: { cors: { origin: "*", credentials: false } },
    // Read by @fastify/helmet's onRequest hook in place of the global options.
    helmet: { crossOriginResourcePolicy: false },
  };

  fastify.get(
    "/.well-known/openid-configuration",
    DISCOVERY_ROUTE_OPTIONS,
    async (_req, reply) => {
      const res = await handleOpenIdConfig(
        new Request(
          config.betterAuth.url + "/.well-known/openid-configuration",
        ),
      );
      const body = (await res.json()) as Record<string, unknown>;
      // Session Management 1.0: the OP advertises an iframe the RP polls for
      // the end-user's OP session status.
      body.check_session_iframe = new URL(
        "/check_session_iframe",
        config.betterAuth.url,
      ).toString();
      return reply
        .status(res.status)
        .header("content-type", "application/json")
        .send(body);
    },
  );

  fastify.get(
    "/.well-known/oauth-authorization-server",
    DISCOVERY_ROUTE_OPTIONS,
    async (_req, reply) => {
      const res = await handleAuthServerMeta(
        new Request(
          config.betterAuth.url + "/.well-known/oauth-authorization-server",
        ),
      );
      const body = await res.json();
      return reply
        .status(res.status)
        .header("content-type", "application/json")
        .send(body);
    },
  );

  // The catch-all `OPTIONS *` route installed by @fastify/cors answers a
  // preflight from an origin outside CORS_ORIGINS with a 404, which fails the
  // discovery preflight. A static route on the same path takes precedence over
  // the wildcard; the preflight response carries the headers @fastify/cors
  // derived from the `cors` override above.
  fastify.options(
    "/.well-known/openid-configuration",
    DISCOVERY_ROUTE_OPTIONS,
    async (_req, reply) => reply.status(204).send(),
  );
  fastify.options(
    "/.well-known/oauth-authorization-server",
    DISCOVERY_ROUTE_OPTIONS,
    async (_req, reply) => reply.status(204).send(),
  );
}
