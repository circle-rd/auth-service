import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { getRequestSession } from "../middleware.js";
import { renderAuthPage, type PageName } from "../services/templates.js";
import {
  BillingPageAccessError,
  billingUsagePageData,
  invoicesPageData,
  requireDelegatedAccess,
  subscribePageData,
  type DelegatedApp,
} from "../services/billing/pages.js";

/**
 * Delegated billing pages: `subscribe`, `invoices` and `billing-usage`, rendered
 * for the signed-in user of an application whose `billing_mode` is `delegated`.
 *
 * Same rule as the other server-rendered pages (see the custom templates guide):
 * a page is rendered from `TEMPLATES_DIR` overrides, then the built-in template.
 * Unlike them, a page that fails to render never falls back to the SPA — the SPA
 * is the service's own administration interface and would show the wrong thing —
 * it answers a static 500 instead, and the error is logged without the page data.
 */

type BillingPage = Extract<
  PageName,
  "subscribe" | "invoices" | "billing-usage"
>;

const PAGE_BUILDERS: Record<
  BillingPage,
  (input: {
    userId: string;
    app: DelegatedApp;
    locale: string;
    cursor?: string;
  }) => Promise<Record<string, unknown>>
> = {
  subscribe: subscribePageData,
  invoices: invoicesPageData,
  "billing-usage": billingUsagePageData,
};

const PAGE_PATHS: Record<BillingPage, string> = {
  subscribe: "/billing/subscribe",
  invoices: "/billing/invoices",
  "billing-usage": "/billing/usage",
};

/** The language a page is rendered in, from the browser's preference. */
function localeOf(req: FastifyRequest): string {
  const header = req.headers["accept-language"];
  const first = (typeof header === "string" ? header : "").split(",")[0] ?? "";
  return /^[a-z]{2}(-[A-Za-z]{2})?$/.test(first.trim()) ? first.trim() : "en";
}

function refuse(reply: FastifyReply, code: string, status: number) {
  return reply
    .status(status)
    .header("content-type", "text/html; charset=utf-8")
    .send(
      renderAuthPage(
        "error",
        {
          actionUrl: "",
          redirectTo: "",
          appSlug: "",
          authUrl: config.betterAuth.url,
          appName: config.appName,
          logoUrl: config.appLogoUrl ?? "",
          logoDarkUrl: config.appLogoDarkUrl ?? "",
          errorCode: code,
          loginUrl: "/login",
        },
        null,
        config.templatesDir,
      ),
    );
}

export async function billingPageRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  for (const page of Object.keys(PAGE_BUILDERS) as BillingPage[]) {
    fastify.get(PAGE_PATHS[page], async (req, reply) => {
      const query = req.query as Record<string, string>;
      const slug = typeof query.client_id === "string" ? query.client_id : "";
      if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
        return refuse(reply, "BILLING_NOT_AVAILABLE", 404);
      }

      const session = await getRequestSession(req);
      if (!session) {
        // Not signed in: the application's own sign-in, then back to this page.
        const back = encodeURIComponent(req.url);
        return reply.redirect(
          `/login?client_id=${encodeURIComponent(slug)}&redirectTo=${back}`,
          302,
        );
      }

      let app: DelegatedApp;
      try {
        app = await requireDelegatedAccess(session.user.id, slug);
      } catch (err) {
        if (err instanceof BillingPageAccessError) {
          if (err.code === "no_access")
            return refuse(reply, "BILLING_NO_ACCESS", 403);
          return refuse(reply, "BILLING_NOT_AVAILABLE", 404);
        }
        throw err;
      }

      const locale = localeOf(req);
      try {
        const data = await PAGE_BUILDERS[page]({
          userId: session.user.id,
          app,
          locale,
          cursor: typeof query.cursor === "string" ? query.cursor : undefined,
        });
        const html = renderAuthPage(
          page,
          {
            actionUrl: "",
            redirectTo: "",
            appSlug: app.slug,
            authUrl: config.betterAuth.url,
            appName: config.appName,
            logoUrl: config.appLogoUrl ?? "",
            logoDarkUrl: config.appLogoDarkUrl ?? "",
            pageData: { ...data, LOCALE: locale },
          },
          app.slug,
          config.templatesDir,
        );
        return reply
          .status(200)
          .header("content-type", "text/html; charset=utf-8")
          .send(html);
      } catch (err) {
        fastify.log.warn(
          {
            page,
            appSlug: app.slug,
            err: err instanceof Error ? err.message : String(err),
          },
          "[templates] billing page failed to render",
        );
        return reply
          .status(500)
          .header("content-type", "text/html; charset=utf-8")
          .send(
            "<!DOCTYPE html><title>Unable to display this page</title><p>This page could not be displayed. Please try again later.</p>",
          );
      }
    });
  }
}
