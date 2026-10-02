/**
 * Fastify application factory.
 *
 * `buildServer()` returns a configured but NOT-listening FastifyInstance.
 * Side-effects deferred to the caller: DB migrations, bootstrap seeding,
 * SMTP transport verification, runtime-config seeding, and `listen()`.
 *
 * Integration tests import `buildServer()` directly and drive it via
 * `app.inject()` without binding a real port. Production entry point lives
 * in `index.ts`.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { APIError } from "better-auth";
import { ZodError } from "zod";
import {
  oauthProviderOpenIdConfigMetadata,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { prettyTransport } from "./logger.js";
import { auth } from "./auth.js";
import { corsOrigins } from "./runtime-config.js";
import { healthRoutes } from "./routes/health.js";
import { applicationRoutes } from "./routes/admin/applications.js";
import { rolesRoutes } from "./routes/admin/roles.js";
import { plansRoutes } from "./routes/admin/plans.js";
import { adminConsumptionRoutes } from "./routes/admin/adminConsumption.js";
import { usersRoutes } from "./routes/admin/users.js";
import { sessionsRoutes } from "./routes/admin/sessions.js";
import { statsRoutes } from "./routes/admin/stats.js";
import { servicesRoutes } from "./routes/admin/services.js";
import { consumptionRoutes } from "./routes/consumption.js";
import { userRoutes } from "./routes/user.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { organizationsRoutes } from "./routes/admin/organizations.js";
import {
  appConfigRoutes,
  globallyEnabledProviders,
} from "./routes/app-config.js";
import { ApiError, ERR } from "./errors.js";
import { renderAuthPage } from "./services/templates.js";
import { createRateLimitStore } from "./services/rate-limit-store.js";
import { db } from "./db/index.js";
import { applications } from "./db/schema.js";
import { eq } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Rate-limit exemptions: see comments in buildServer() below.
const RATE_LIMIT_EXEMPT_PATHS = [
  "/api/auth/oauth2/token",
  "/api/auth/jwks",
  "/api/auth/.well-known/",
];
const AUTH_RATE_PATHS = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/social",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/auth/sign-up/email",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
];
const AUTH_RATE_MAX = 10;
const AUTH_RATE_WINDOW = 60_000;

const EMAIL_SEND_PATHS = [
  // BetterAuth >=1.6 renamed `/forget-password` to `/request-password-reset`;
  // the legacy path is kept for back-compat with older clients that still POST
  // to it (it routes to the same handler via plugin aliases).
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/send-verification-email",
  "/api/auth/sign-in/magic-link",
  "/api/auth/change-email",
  "/api/auth/organization/invite-member",
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/email-otp/request-password-reset",
];
const EMAIL_SEND_MAX = 5;
const EMAIL_SEND_WINDOW = 60_000;

// Device authorization (RFC 8628, opt-in). `/device/code` is unauthenticated
// and writes a row per call; `/device/token` is polled every few seconds per
// device, so it needs a looser ceiling than credential endpoints.
const DEVICE_RATE_PATHS = ["/api/auth/device"];
const DEVICE_RATE_MAX = 60;
const DEVICE_RATE_WINDOW = 60_000;

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    // Trust the reverse-proxy chain so `req.ip` reflects the real
    // client address from `X-Forwarded-For` instead of the proxy's address —
    // and, crucially, so a client-forged `X-Forwarded-For` cannot move the
    // rate-limit bucket. The number of trusted hops is configurable.
    trustProxy: config.trustProxyHops,
    logger: {
      level: config.isDev ? "debug" : "info",
      transport: prettyTransport(),
      serializers: {
        // Never log the query string: it can carry password-reset,
        // email-verification and magic-link tokens.
        req(req: { method?: string; url?: string }) {
          return {
            method: req.method,
            url: (req.url ?? "").split("?")[0],
          };
        },
      },
    },
  });

  // ── Security headers ────────────────────────────────────────────────────
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

  // ── CORS ────────────────────────────────────────────────────────────────
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

  // ── Generic global rate-limit ───────────────────────────────────────────
  await fastify.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    allowList: (req) => {
      const url = req.url ?? "";
      return RATE_LIMIT_EXEMPT_PATHS.some((p) => url.startsWith(p));
    },
  });

  // ── Strict rate buckets for sensitive auth + email endpoints ────────────
  // Backed by an in-process counter by default; when REDIS_URL is set the
  // store is shared across instances (see services/rate-limit-store.ts).
  const rateLimitStore = await createRateLimitStore(config.redis.url);
  fastify.addHook("onClose", async () => {
    await rateLimitStore.close();
  });

  // ── Static frontend (built Vue SPA) ─────────────────────────────────────
  const frontendDist = join(__dirname, "..", "frontend-dist");

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
    return reply.status(404).send({ error: "Not found" });
  }

  if (existsSync(frontendDist)) {
    await fastify.register(staticFiles, {
      root: frontendDist,
      prefix: "/",
      wildcard: false,
    });
  }

  // ── Auth page routes ────────────────────────────────────────────────────
  const authPageRoutes: Array<{
    path: string;
    page: "login" | "register" | "verify-email" | "two-factor";
  }> = [
    { path: "/login", page: "login" },
    { path: "/register", page: "register" },
    { path: "/verify-email", page: "verify-email" },
    { path: "/two-factor", page: "two-factor" },
  ];

  for (const { path, page } of authPageRoutes) {
    fastify.get(path, async (req, reply) => {
      const query = req.query as Record<string, string>;
      const appSlug = query.client_id ?? "";
      const rawUrl = req.raw.url ?? "";
      const rawQs = rawUrl.includes("?")
        ? rawUrl.split("?").slice(1).join("?")
        : "";

      let allowRegister = false;
      let socialProvidersJson: string;
      if (appSlug) {
        const [appRow] = await db
          .select({
            allowRegister: applications.allowRegister,
            enabledSocialProviders: applications.enabledSocialProviders,
          })
          .from(applications)
          .where(eq(applications.slug, appSlug))
          .limit(1);
        allowRegister = appRow?.allowRegister ?? false;

        const globalProviders = globallyEnabledProviders();
        const appProviders =
          appRow?.enabledSocialProviders === null ||
          appRow?.enabledSocialProviders === undefined
            ? globalProviders
            : (appRow.enabledSocialProviders as string[]).filter((p) =>
                globalProviders.includes(p as never),
              );
        socialProvidersJson = JSON.stringify(appProviders);
      } else {
        socialProvidersJson = JSON.stringify(globallyEnabledProviders());
      }

      if (page === "register" && !allowRegister) {
        const loginUrl = rawQs ? `/login?${rawQs}` : "/login";
        return reply.redirect(loginUrl, 302);
      }

      if (!config.templatesDir) {
        if (existsSync(frontendDist)) {
          return reply.sendFile("index.html", frontendDist);
        }
        return reply.status(404).send({ error: "Not found" });
      }

      const rawRedirect = query.redirectTo ?? query.next ?? "/";
      const redirectTo =
        typeof rawRedirect === "string" &&
        rawRedirect.startsWith("/") &&
        !rawRedirect.startsWith("//")
          ? rawRedirect
          : "/";
      const oauthQuery =
        query.client_id !== undefined && query.sig !== undefined ? rawQs : "";

      const encodedRedirect = encodeURIComponent(redirectTo);
      const loginUrl = oauthQuery
        ? `/login?${oauthQuery}`
        : `/login?redirectTo=${encodedRedirect}`;
      const registerUrl =
        allowRegister && oauthQuery
          ? `/register?${oauthQuery}`
          : `/register?redirectTo=${encodedRedirect}`;

      try {
        const html = renderAuthPage(
          page,
          {
            actionUrl: `/api/auth/sign-in/email`,
            redirectTo,
            appSlug,
            authUrl: config.betterAuth.url,
            errorMessage: query.error,
            oauthQuery,
            allowRegister,
            socialProvidersJson,
            loginUrl,
            registerUrl,
          },
          appSlug || null,
          config.templatesDir,
        );
        return reply
          .status(200)
          .header("content-type", "text/html; charset=utf-8")
          .send(html);
      } catch (err) {
        return sendSpaFallback(reply, page, appSlug || null, err);
      }
    });
  }

  // ── Organization selection page ─────────────────────────────────────────
  fastify.get("/select-org", async (req, reply) => {
    if (!config.templatesDir) {
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.status(404).send({ error: "Not found" });
    }

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      const rawUrl = req.raw.url ?? "";
      const rawQs = rawUrl.includes("?")
        ? rawUrl.split("?").slice(1).join("?")
        : "";
      return reply.redirect(`/login${rawQs ? `?${rawQs}` : ""}`, 302);
    }

    const organizations = await auth.api.listOrganizations({
      headers: fromNodeHeaders(req.headers),
    });

    const query = req.query as Record<string, string>;
    const rawUrl = req.raw.url ?? "";
    const rawQs = rawUrl.includes("?")
      ? rawUrl.split("?").slice(1).join("?")
      : "";
    const oauthQuery =
      query.client_id !== undefined && query.sig !== undefined ? rawQs : "";

    try {
      const html = renderAuthPage(
        "select-org",
        {
          actionUrl: "",
          redirectTo: "",
          appSlug: query.client_id ?? "",
          authUrl: config.betterAuth.url,
          oauthQuery,
          organizationsJson: JSON.stringify(
            (organizations ?? []).map((o) => ({
              id: (o as Record<string, unknown>).id,
              name: (o as Record<string, unknown>).name,
              slug: (o as Record<string, unknown>).slug,
              logo: (o as Record<string, unknown>).logo ?? null,
            })),
          ),
        },
        query.client_id ?? null,
        config.templatesDir,
      );
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .send(html);
    } catch (err) {
      return sendSpaFallback(reply, "select-org", query.client_id ?? null, err);
    }
  });

  // ── Device authorization approval page (RFC 8628, opt-in) ───────────────
  fastify.get("/device", async (req, reply) => {
    if (!config.features.deviceAuthorization) {
      return reply
        .status(404)
        .send({ error: { code: "SRV_001", message: "Not found" } });
    }

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      const code = (req.query as Record<string, string>).user_code;
      const suffix = code ? `?user_code=${encodeURIComponent(code)}` : "";
      return reply.redirect(`/login?redirectTo=/device${suffix}`, 302);
    }

    if (!config.templatesDir) {
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.status(404).send({ error: "Not found" });
    }

    try {
      const html = renderAuthPage(
        "device",
        {
          actionUrl: "",
          redirectTo: "",
          appSlug: "",
          authUrl: config.betterAuth.url,
        },
        null,
        config.templatesDir,
      );
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .send(html);
    } catch (err) {
      return sendSpaFallback(reply, "device", null, err);
    }
  });

  // ── BetterAuth handler — intercept before Fastify body-parsing ──────────
  const betterAuthHandler = toNodeHandler(auth);
  fastify.addHook("onRequest", async (req, reply) => {
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

    const urlPath = req.url.split("?")[0] ?? "";
    const ip = req.ip ?? "unknown";
    if (
      AUTH_RATE_PATHS.some((p) => urlPath === p || urlPath.startsWith(p + "/"))
    ) {
      const allowed = await rateLimitStore.hit(
        `auth:${ip}`,
        AUTH_RATE_MAX,
        AUTH_RATE_WINDOW,
      );
      if (!allowed) {
        reply.raw.writeHead(429, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify(ERR.RATE_001().toJSON()));
        return;
      }
    }
    if (
      EMAIL_SEND_PATHS.some((p) => urlPath === p || urlPath.startsWith(p + "/"))
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
      config.features.deviceAuthorization &&
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

    reply.hijack();
    betterAuthHandler(req.raw, reply.raw);
  });

  // ── Routes ──────────────────────────────────────────────────────────────
  // Stripe webhook first — its raw Buffer parser must take precedence.
  await fastify.register(stripeWebhookRoutes, {
    prefix: "/api/webhooks/stripe",
  });
  await fastify.register(healthRoutes);
  await fastify.register(applicationRoutes, {
    prefix: "/api/admin/applications",
  });
  await fastify.register(rolesRoutes, { prefix: "/api/admin" });
  await fastify.register(plansRoutes, { prefix: "/api/admin" });
  await fastify.register(adminConsumptionRoutes, { prefix: "/api/admin" });
  await fastify.register(usersRoutes, { prefix: "/api/admin/users" });
  await fastify.register(sessionsRoutes, { prefix: "/api/admin/sessions" });
  await fastify.register(statsRoutes, { prefix: "/api/admin/stats" });
  await fastify.register(servicesRoutes, { prefix: "/api/admin/services" });
  await fastify.register(organizationsRoutes, {
    prefix: "/api/admin/organizations",
  });
  await fastify.register(consumptionRoutes, { prefix: "/api/consumption" });
  await fastify.register(userRoutes, { prefix: "/api/user" });
  await fastify.register(appConfigRoutes, { prefix: "/api/app-config" });

  // ── OIDC / OAuth 2.0 discovery at root ──────────────────────────────────
  const handleOpenIdConfig = oauthProviderOpenIdConfigMetadata(auth);
  const handleAuthServerMeta = oauthProviderAuthServerMetadata(auth);

  fastify.get("/.well-known/openid-configuration", async (_req, reply) => {
    const res = await handleOpenIdConfig(
      new Request(config.betterAuth.url + "/.well-known/openid-configuration"),
    );
    const body = await res.json();
    return reply
      .status(res.status)
      .header("content-type", "application/json")
      .send(body);
  });

  fastify.get(
    "/.well-known/oauth-authorization-server",
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

  // ── SPA fallback ────────────────────────────────────────────────────────
  fastify.setNotFoundHandler(async (req, reply) => {
    if (
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/api/auth/") &&
      existsSync(frontendDist)
    ) {
      return reply.sendFile("index.html", frontendDist);
    }
    await reply
      .status(404)
      .send({ error: { code: "SRV_001", message: "Not found" } });
  });

  // ── Global error handler ────────────────────────────────────────────────
  fastify.setErrorHandler(async (error, _req, reply) => {
    if (error instanceof ApiError) {
      await reply.status(error.statusCode).send(error.toJSON());
      return;
    }

    // Zod validation errors from route schemas map to 400 without leaking the
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
      const body = error.body as
        { code?: string; message?: string } | undefined;
      await reply.status(status).send({
        error: {
          code: body?.code ?? "AUTH_001",
          message: body?.message ?? error.message,
        },
      });
      return;
    }

    const err = error as { validation?: unknown };
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

    fastify.log.error(error);
    await reply.status(500).send({
      error: { code: "SRV_001", message: "Internal server error" },
    });
  });

  return fastify;
}
