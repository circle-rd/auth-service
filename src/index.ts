import Fastify from "fastify";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
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
import { adminConsumptionRoutes } from "./routes/admin/adminConsumption.js";
import { usersRoutes } from "./routes/admin/users.js";
import { sessionsRoutes } from "./routes/admin/sessions.js";
import { servicesRoutes } from "./routes/admin/services.js";
import { consumptionRoutes } from "./routes/consumption.js";
import { userRoutes } from "./routes/user.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { organizationsRoutes } from "./routes/admin/organizations.js";
import { appConfigRoutes, globallyEnabledProviders } from "./routes/app-config.js";
import { ApiError } from "./errors.js";
import { renderAuthPage } from "./services/templates.js";
import { db } from "./db/index.js";
import { applications } from "./db/schema.js";
import { eq } from "drizzle-orm";

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
] as const;

for (const { path, page } of authPageRoutes) {
  fastify.get(path, async (req, reply) => {
    const query = req.query as Record<string, string>;
    const appSlug = query.client_id ?? "";
    const rawUrl = req.raw.url ?? "";
    const rawQs = rawUrl.includes("?")
      ? rawUrl.split("?").slice(1).join("?")
      : "";

    // Resolve allowRegister before choosing the render mode so the guard fires
    // in both template and SPA paths regardless of TEMPLATES_DIR.
    let allowRegister = true;
    let socialProvidersJson = "[]";
    if (appSlug) {
      const [appRow] = await db
        .select({
          allowRegister: applications.allowRegister,
          enabledSocialProviders: applications.enabledSocialProviders,
        })
        .from(applications)
        .where(eq(applications.slug, appSlug))
        .limit(1);
      allowRegister = appRow?.allowRegister ?? true;

      // Compute social providers: null → inherit all globally active providers;
      // explicit array → intersect with globally active providers so a provider
      // removed from .env cannot be forced on by the DB value.
      const globalProviders = globallyEnabledProviders();
      const appProviders =
        appRow?.enabledSocialProviders === null || appRow?.enabledSocialProviders === undefined
          ? globalProviders
          : (appRow.enabledSocialProviders as string[]).filter((p) =>
              globalProviders.includes(p as never),
            );
      socialProvidersJson = JSON.stringify(appProviders);
    } else {
      // No client_id — expose globally active providers
      socialProvidersJson = JSON.stringify(globallyEnabledProviders());
    }

    if (page === "register" && !allowRegister) {
      const loginUrl = rawQs ? `/login?${rawQs}` : "/login";
      return reply.redirect(loginUrl, 302);
    }

    // Only serve custom template when TEMPLATES_DIR is configured.
    // Without it, fall through to the Vue SPA (handled by the static file
    // plugin or the notFound handler below).
    if (!config.templatesDir) {
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.status(404).send({ error: "Not found" });
    }

    const redirectTo = query.redirectTo ?? query.next ?? "/";
    // When BetterAuth's oauthProvider initiates the login, it signs all OAuth
    // params (including client_id + sig). Pass the raw query string back to the
    // template so the sign-in form can include it as `oauth_query` in the body,
    // allowing BetterAuth's after-hook to resume the authorization flow.
    const oauthQuery =
      query.client_id !== undefined && query.sig !== undefined ? rawQs : "";

    // Pre-compute cross-links that preserve the full OAuth context so templates
    // never lose the signed query when navigating between login and register.
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
    } catch {
      // Template not found — fall back to Vue SPA
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.status(404).send({ error: "Not found" });
    }
  });
}

// ── Organization selection page (postLogin OAuth2 flow) ──────────────────────
// BetterAuth's oauthProvider redirects here when the client requests the "org"
// scope and the user needs to select their active organization.
fastify.get("/select-org", async (req, reply) => {
  if (!config.templatesDir) {
    if (existsSync(frontendDist)) {
      return reply.sendFile("index.html", frontendDist);
    }
    return reply.status(404).send({ error: "Not found" });
  }

  // Retrieve the authenticated session.
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) {
    const query = req.query as Record<string, string>;
    const rawUrl = req.raw.url ?? "";
    const rawQs = rawUrl.includes("?") ? rawUrl.split("?").slice(1).join("?") : "";
    return reply.redirect(`/login${rawQs ? `?${rawQs}` : ""}`, 302);
  }

  // Enumerate the user's organizations to populate the selection list.
  const organizations = await auth.api.listOrganizations({
    headers: fromNodeHeaders(req.headers),
  });

  const query = req.query as Record<string, string>;
  const rawUrl = req.raw.url ?? "";
  const rawQs = rawUrl.includes("?") ? rawUrl.split("?").slice(1).join("?") : "";
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
  } catch {
    if (existsSync(frontendDist)) {
      return reply.sendFile("index.html", frontendDist);
    }
    return reply.status(404).send({ error: "Not found" });
  }
});

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
await fastify.register(adminConsumptionRoutes, { prefix: "/api/admin" });
await fastify.register(usersRoutes, { prefix: "/api/admin/users" });
await fastify.register(sessionsRoutes, { prefix: "/api/admin/sessions" });
await fastify.register(servicesRoutes, { prefix: "/api/admin/services" });
await fastify.register(organizationsRoutes, { prefix: "/api/admin/organizations" });
await fastify.register(consumptionRoutes, { prefix: "/api/consumption" });
await fastify.register(userRoutes, { prefix: "/api/user" });
await fastify.register(appConfigRoutes, { prefix: "/api/app-config" });

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
