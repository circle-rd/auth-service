import { type FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { auth } from "../auth.js";
import { socialProvidersFor } from "../routes/app-config.js";
import {
  CONFIRMATION_STATUSES,
  EMAIL_VERIFIED_PATH,
  renderAuthPage,
  type PageName,
} from "../services/templates.js";
import {
  narrowSocialProvidersByLastUsed,
  parseLastUsedLoginMethod,
} from "../services/last-login-method.js";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { SpaFallback } from "./spa.js";

/**
 * Accept a same-origin relative path and nothing else.
 *
 * A leading `//` makes the value protocol-relative, and browsers treat a
 * leading backslash like a slash — so `/\/evil.com` and `/\evil.com` would both
 * resolve to another origin. Either form would turn a `redirectTo` or a
 * back-to-sign-in link into an open redirect, so any backslash or whitespace is
 * rejected outright.
 */
function safeRelativePath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (/[\\\s]/.test(value)) return fallback;
  return value;
}

export function registerAuthPages(
  fastify: FastifyInstance,
  {
    frontendDist,
    sendSpaFallback,
  }: { frontendDist: string; sendSpaFallback: SpaFallback },
): void {
  // ── Auth page routes ────────────────────────────────────────────
  // `email-verified` is the post-verification confirmation page. It is the
  // `callbackURL` both verification flows redirect to, so it must be reachable
  // without a session — it reads only the `status` query parameter and never
  // touches the session.
  const authPageRoutes: Array<{
    path: string;
    page: PageName;
  }> = [
    { path: "/login", page: "login" },
    { path: "/register", page: "register" },
    { path: "/verify-email", page: "verify-email" },
    { path: EMAIL_VERIFIED_PATH, page: "email-verified" },
    { path: "/two-factor", page: "two-factor" },
  ];

  for (const { path, page } of authPageRoutes) {
    fastify.get(path, async (req, reply) => {
      const query = req.query as Record<string, string>;
      const appSlug = query.client_id ?? "";
      // The confirmation page reports which flow completed. Anything else is
      // not one of our statuses, so it stays empty and the page falls back to
      // its neutral wording rather than echoing untrusted input.
      const confirmationStatus = CONFIRMATION_STATUSES.find(
        (value) => value === query.status,
      );
      const rawUrl = req.raw.url ?? "";
      const rawQs = rawUrl.includes("?")
        ? rawUrl.split("?").slice(1).join("?")
        : "";

      // Without a client_id this is the service's own sign-in (administration
      // interface, device approval): no social providers, as in the SPA login.
      // An unknown client_id gets none either.
      let allowRegister = false;
      let socialProviders: string[] = [];
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
        if (appRow) {
          socialProviders = socialProvidersFor(appRow.enabledSocialProviders);
        }
      }
      // Narrow the offered social buttons to the provider this browser last
      // signed in with, so a returning social user keeps a one-click path while
      // a new visitor is not steered towards a sign-up the app may not allow.
      // Registration pages keep the full list: a new account has no history.
      const lastUsedLoginMethod = parseLastUsedLoginMethod(req.headers.cookie);
      const socialProvidersAllJson = JSON.stringify(socialProviders);
      const socialProvidersJson = JSON.stringify(
        page === "login"
          ? narrowSocialProvidersByLastUsed(
              socialProviders,
              lastUsedLoginMethod,
            )
          : socialProviders,
      );

      if (page === "register" && !allowRegister) {
        const params = new URLSearchParams({ error: "REGISTRATION_CLOSED" });
        if (appSlug) params.set("client_id", appSlug);
        if (rawQs) params.set("login", `/login?${rawQs}`);
        return reply.redirect(`/error?${params.toString()}`, 302);
      }

      // The service's own sign-in (no client_id) is the admin SPA's login page,
      // with the service's branding and theme. Templates are the sign-in pages of
      // applications; one of them is never the service's own.
      if (!config.templatesDir || (page === "login" && !appSlug)) {
        if (existsSync(frontendDist)) {
          return reply.sendFile("index.html", frontendDist);
        }
        return reply.callNotFound();
      }

      const rawRedirect = query.redirectTo ?? query.next ?? "/";
      const redirectTo = safeRelativePath(rawRedirect, "/");
      const oauthQuery =
        query.client_id !== undefined && query.sig !== undefined ? rawQs : "";

      const encodedRedirect = encodeURIComponent(redirectTo);
      // Back to the application's own sign-in, which only the client_id names
      // when the request was not a signed OAuth one: without it `/login` is the
      // service's own sign-in.
      const loginUrl = oauthQuery
        ? `/login?${oauthQuery}`
        : `/login?redirectTo=${encodedRedirect}${
            appSlug ? `&client_id=${encodeURIComponent(appSlug)}` : ""
          }`;
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
            socialProvidersAllJson,
            loginUrl,
            registerUrl,
            confirmationStatus,
            appName: config.appName,
            logoUrl: config.appLogoUrl ?? "",
            logoDarkUrl: config.appLogoDarkUrl ?? "",
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

  // ── Templated authentication-error page ─────────────────────────
  // The OAuth provider plugin redirects unrecoverable authorization errors to
  // `onAPIError.errorURL` (`/error`, set in `src/auth.ts`), and our own flows
  // (a refused registration, an invalid invitation) redirect here too. Rendering
  // through the template system lets an application ship its own design via
  // `TEMPLATES_DIR/<slug>/error.html`; without a `TEMPLATES_DIR` the SPA keeps
  // handling every non-API path.
  fastify.get("/error", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const appSlug = typeof query.client_id === "string" ? query.client_id : "";
    const errorCode = typeof query.error === "string" ? query.error : "";
    const errorDescription =
      typeof query.error_description === "string"
        ? query.error_description
        : "";
    // Only a same-origin relative path is honoured, so `login` cannot be turned
    // into an open redirect.
    const loginUrl = safeRelativePath(query.login, "/login");

    if (!config.templatesDir) {
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.callNotFound();
    }

    try {
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
          errorCode,
          errorDescription,
          loginUrl,
        },
        appSlug || null,
        config.templatesDir,
      );
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .send(html);
    } catch (err) {
      return sendSpaFallback(reply, "error", appSlug || null, err);
    }
  });

  // ── Organization selection page ─────────────────────────────────
  fastify.get("/select-org", async (req, reply) => {
    if (!config.templatesDir) {
      if (existsSync(frontendDist)) {
        return reply.sendFile("index.html", frontendDist);
      }
      return reply.callNotFound();
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

  // ── Device authorization approval page (RFC 8628, opt-in) ───────
  fastify.get("/device", async (req, reply) => {
    if (
      !config.features.deviceAuthorization &&
      !config.features.oauthDeviceGrant
    ) {
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
      return reply.callNotFound();
    }

    try {
      const html = renderAuthPage(
        "device",
        {
          actionUrl: "",
          redirectTo: "",
          appSlug: "",
          authUrl: config.betterAuth.url,
          sessionEmail: session.user.email,
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
}
