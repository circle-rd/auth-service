import Fastify from "fastify";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import { toNodeHandler } from "better-auth/node";
import {
  oauthProviderOpenIdConfigMetadata,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { auth } from "./auth.js";
import { bootstrap } from "./bootstrap.js";
import { runMigrations } from "./migrate.js";
import { healthRoutes } from "./routes/health.js";
import { applicationRoutes } from "./routes/admin/applications.js";
import { rolesRoutes } from "./routes/admin/roles.js";
import { plansRoutes } from "./routes/admin/plans.js";
import { usersRoutes } from "./routes/admin/users.js";
import { sessionsRoutes } from "./routes/admin/sessions.js";
import { servicesRoutes } from "./routes/admin/services.js";
import { consumptionRoutes } from "./routes/consumption.js";
import { userRoutes } from "./routes/user.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { ApiError } from "./errors.js";
import { renderAuthPage } from "./services/templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({
  logger: {
    level: config.isDev ? "debug" : "info",
    transport: config.isDev
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  },
});

// ── CORS ──────────────────────────────────────────────────────────────────────
await fastify.register(cors, {
  origin: config.cors.origins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

// ── Static frontend (built Vue SPA) ──────────────────────────────────────────
const frontendDist = join(__dirname, "..", "frontend-dist");
if (existsSync(frontendDist)) {
  await fastify.register(staticFiles, {
    root: frontendDist,
    prefix: "/",
    wildcard: false,
  });
}

// ── Auth page routes — served before Vue SPA ─────────────────────────────────
// BetterAuth's oauthProvider redirects to /login carrying the full signed OAuth
// params in the query string (client_id, sig, exp, …), NOT a plain redirectTo.
// These routes serve either a custom HTML template (from TEMPLATES_DIR) or
// fall through to the Vue SPA index.html when no template is found.
const authPageRoutes: Array<{
  path: string;
  page: "login" | "register" | "verify-email";
}> = [
  { path: "/login", page: "login" },
  { path: "/register", page: "register" },
  { path: "/verify-email", page: "verify-email" },
];

for (const { path, page } of authPageRoutes) {
  fastify.get(path, async (req, reply) => {
    // Only serve custom template when TEMPLATES_DIR is configured.
    // Without it, fall through to the Vue SPA (handled by the static file
    // plugin or the notFound handler below).
    if (!config.templatesDir) {
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.status(404).send({ error: "Not found" });
    }

    const query = req.query as Record<string, string>;
    const redirectTo = query.redirectTo ?? query.next ?? "/";
    const appSlug = query.client_id ?? "";

    // When BetterAuth's oauthProvider initiates the login, it signs all OAuth
    // params (including client_id + sig). Pass the raw query string back to the
    // template so the sign-in form can include it as `oauth_query` in the body,
    // allowing BetterAuth's after-hook to resume the authorization flow.
    const rawUrl = req.raw.url ?? "";
    const rawQs = rawUrl.includes("?")
      ? rawUrl.split("?").slice(1).join("?")
      : "";
    const oauthQuery =
      query.client_id !== undefined && query.sig !== undefined ? rawQs : "";

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
        },
        appSlug || null,
        config.templatesDir,
      );
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .send(html);
    } catch {
      // Template not found — fall back to Vue SPA
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.status(404).send({ error: "Not found" });
    }
  });
}

// ── BetterAuth handler — intercept before Fastify body-parsing ───────────────
// Must run in onRequest (before preParsing) so the raw stream is still intact.
// reply.hijack() bypasses @fastify/cors, so we inject CORS headers manually.
const betterAuthHandler = toNodeHandler(auth);
fastify.addHook("onRequest", (req, reply, done) => {
  if (req.url?.startsWith("/api/auth/")) {
    const origin = req.headers.origin;
    if (origin && (config.cors.origins as string[]).includes(origin)) {
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
    // Handle preflight without consuming the body
    if (req.method === "OPTIONS") {
      reply.raw.writeHead(204);
      reply.raw.end();
      return;
    }
    reply.hijack();
    betterAuthHandler(req.raw, reply.raw);
  } else {
    done();
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
// Stripe webhook must be registered first — it uses a raw Buffer body parser
// scoped to its plugin, which takes precedence over the default JSON parser.
await fastify.register(stripeWebhookRoutes, { prefix: "/api/webhooks/stripe" });
await fastify.register(healthRoutes);
await fastify.register(applicationRoutes, {
  prefix: "/api/admin/applications",
});
await fastify.register(rolesRoutes, { prefix: "/api/admin" });
await fastify.register(plansRoutes, { prefix: "/api/admin" });
await fastify.register(usersRoutes, { prefix: "/api/admin/users" });
await fastify.register(sessionsRoutes, { prefix: "/api/admin/sessions" });
await fastify.register(servicesRoutes, { prefix: "/api/admin/services" });
await fastify.register(consumptionRoutes, { prefix: "/api/consumption" });
await fastify.register(userRoutes, { prefix: "/api/user" });

// ── OIDC / OAuth 2.0 discovery at root (RFC 8414 / OIDC Core §4) ──────────────
// BetterAuth serves these under /api/auth/.well-known/… but many clients look
// for them at the root of the issuer (https://auth.example.com/.well-known/…).
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

fastify.get("/.well-known/oauth-authorization-server", async (_req, reply) => {
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
});

// ── SPA fallback — serve index.html for all unmatched routes ─────────────────
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

// ── Global error handler ──────────────────────────────────────────────────────
fastify.setErrorHandler(async (error, _req, reply) => {
  if (error instanceof ApiError) {
    await reply.status(error.statusCode).send(error.toJSON());
    return;
  }

  // Fastify validation errors
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

// ── Startup ───────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    // Run migrations automatically in production; in dev use `pnpm db:push`
    if (!config.isDev) {
      await runMigrations();
    }
    await bootstrap();
    await fastify.listen({ port: config.port, host: config.host });
    fastify.log.info(`auth-service listening on ${config.host}:${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

await start();
