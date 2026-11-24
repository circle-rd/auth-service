import { type FastifyInstance } from "fastify";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { config } from "../config.js";
import { auth } from "../auth.js";
import { corsOrigins } from "../runtime-config.js";
import {
  appendSessionState,
  createSessionState,
} from "../services/session-management.js";
import { ERR } from "../errors.js";
import type { RateLimitStore } from "../services/rate-limit-store.js";
import {
  AUTH_RATE_PATHS,
  AUTH_RATE_WINDOW,
  DEVICE_RATE_MAX,
  DEVICE_RATE_PATHS,
  DEVICE_RATE_WINDOW,
  EMAIL_SEND_MAX,
  EMAIL_SEND_PATHS,
  EMAIL_SEND_PATH_PATTERNS,
  EMAIL_SEND_WINDOW,
  MFA_RATE_MAX,
  MFA_RATE_PATHS,
  MFA_RATE_WINDOW,
  TEAM_RATE_MAX,
  TEAM_RATE_PATTERNS,
  TEAM_RATE_WINDOW,
} from "./rate-limit-policy.js";

export function registerAuthRequestHook(
  fastify: FastifyInstance,
  rateLimitStore: RateLimitStore,
): void {
  // ── BetterAuth handler — intercept before Fastify body-parsing ──
  const betterAuthHandler = toNodeHandler(auth);
  fastify.addHook("onRequest", async (req, reply) => {
    const urlPath = req.url.split("?")[0] ?? "";
    const ip = req.ip ?? "unknown";

    // The email bucket also covers owner routes outside /api/auth (resource
    // invitations), so it is evaluated before the BetterAuth-only branch.
    // Reads and CORS preflights never send mail and must not consume it.
    if (
      req.method === "POST" &&
      (EMAIL_SEND_PATHS.some(
        (p) => urlPath === p || urlPath.startsWith(p + "/"),
      ) ||
        EMAIL_SEND_PATH_PATTERNS.some((pattern) => pattern.test(urlPath)))
    ) {
      const allowed = await rateLimitStore.hit(
        `email:${ip}`,
        EMAIL_SEND_MAX,
        EMAIL_SEND_WINDOW,
      );
      if (!allowed) {
        reply.raw.writeHead(429, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify(ERR.MAIL_003().toJSON()));
        return;
      }
    }

    if (
      req.method === "POST" &&
      TEAM_RATE_PATTERNS.some((pattern) => pattern.test(urlPath))
    ) {
      const allowed = await rateLimitStore.hit(
        `team:${ip}`,
        TEAM_RATE_MAX,
        TEAM_RATE_WINDOW,
      );
      if (!allowed) {
        reply.raw.writeHead(429, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify(ERR.RATE_001().toJSON()));
        return;
      }
    }

    if (!req.url?.startsWith("/api/auth/")) return;

    const origin = req.headers.origin;
    if (origin && corsOrigins.has(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With",
      );
      reply.raw.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
    if (req.method === "OPTIONS") {
      reply.raw.writeHead(204);
      reply.raw.end();
      return;
    }

    if (
      AUTH_RATE_PATHS.some((p) => urlPath === p || urlPath.startsWith(p + "/"))
    ) {
      const allowed = await rateLimitStore.hit(
        `auth:${ip}`,
        config.rateLimit.authMax,
        AUTH_RATE_WINDOW,
      );
      if (!allowed) {
        reply.raw.writeHead(429, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify(ERR.RATE_001().toJSON()));
        return;
      }
    }
    if (
      MFA_RATE_PATHS.some((p) => urlPath === p || urlPath.startsWith(p + "/"))
    ) {
      const allowed = await rateLimitStore.hit(
        `mfa:${ip}`,
        MFA_RATE_MAX,
        MFA_RATE_WINDOW,
      );
      if (!allowed) {
        reply.raw.writeHead(429, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify(ERR.RATE_001().toJSON()));
        return;
      }
    }
    if (
      (config.features.deviceAuthorization ||
        config.features.oauthDeviceGrant) &&
      DEVICE_RATE_PATHS.some(
        (p) => urlPath === p || urlPath.startsWith(p + "/"),
      )
    ) {
      const allowed = await rateLimitStore.hit(
        `device:${ip}`,
        DEVICE_RATE_MAX,
        DEVICE_RATE_WINDOW,
      );
      if (!allowed) {
        reply.raw.writeHead(429, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify(ERR.RATE_001().toJSON()));
        return;
      }
    }

    // OIDC Session Management: the authentication response carries an opaque
    // `session_state` for the check_session_iframe. It is only meaningful on
    // the final redirect back to a client (a `code`/`error` response).
    let sessionState: string | undefined;
    if (
      urlPath === "/api/auth/oauth2/authorize" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      const query = req.query as Record<string, string | undefined>;
      const clientId = query.client_id;
      const redirectUri = query.redirect_uri;
      if (clientId && redirectUri) {
        try {
          const activeSession = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
          });
          if (activeSession?.session?.id) {
            sessionState = createSessionState(
              activeSession.session.id,
              clientId,
              new URL(redirectUri).origin,
            );
          }
        } catch {
          // An unreadable session simply yields no session_state; the
          // authorization endpoint decides whether the request can proceed.
        }
      }
    }

    reply.hijack();
    if (urlPath === "/api/auth/jwks") {
      // Public signing keys: safe to cache briefly everywhere, and the short
      // TTL keeps a rotated key set from lingering in intermediaries.
      reply.raw.setHeader("cache-control", "public, max-age=60");
    }
    if (sessionState) {
      const original = reply.raw.setHeader.bind(reply.raw);
      const patched = (
        name: string,
        value: number | string | readonly string[],
      ): void => {
        original(
          name,
          name.toLowerCase() === "location" && typeof value === "string"
            ? appendSessionState(value, sessionState)
            : value,
        );
      };
      reply.raw.setHeader = patched as unknown as typeof reply.raw.setHeader;
    }
    betterAuthHandler(req.raw, reply.raw);
  });
}
