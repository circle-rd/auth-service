import { type FastifyInstance } from "fastify";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config.js";
import { RATE_LIMIT_EXEMPT_PATHS } from "./rate-limit-policy.js";

export async function registerEdgePlugins(
  fastify: FastifyInstance,
): Promise<void> {
  // ── Security headers ────────────────────────────────────────────
  // HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy. CSP keeps
  // 'unsafe-inline' because the auth pages ship small inline scripts; tighten
  // once those move to bundled files.
  await fastify.register(helmet, {
    contentSecurityPolicy: config.isDev
      ? false
      : {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: [
              "'self'",
              "'unsafe-inline'",
              "https://fonts.googleapis.com",
            ],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", config.betterAuth.url],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
          },
        },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  });

  // ── CORS ────────────────────────────────────────────────────────
  // Only the dashboard origins (CORS_ORIGINS) get credentialed CORS on the
  // API. Registered application origins are handled separately for
  // /api/auth/* in the onRequest hook below, so an application origin can
  // never read credentialed responses from admin or data routes.
  const dashboardOrigins = new Set(config.cors.origins);
  await fastify.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      callback(null, dashboardOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // ── Generic global rate-limit ───────────────────────────────────
  await fastify.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    allowList: (req) => {
      const url = req.url ?? "";
      return RATE_LIMIT_EXEMPT_PATHS.some((p) => url.startsWith(p));
    },
  });

  // ── Response compression ────────────────────────────────────────
  // zstd, brotli, then gzip by the client's preference; payloads under 1 KiB are
  // sent as they are. Registered before the static frontend, which the plugin
  // requires. The event stream is hijacked and bypasses this hook.
  await fastify.register(compress);
}
