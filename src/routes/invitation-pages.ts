import type { FastifyInstance, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { globallyEnabledProviders, socialProvidersFor } from "./app-config.js";
import { renderAuthPage } from "../services/templates.js";
import {
  findOrganizationInvitation,
  hasAccountWithEmail,
  organizationInvitationState,
} from "../services/organization-invitations.js";
import {
  findRegistrationInvitationByToken,
  invitationState,
} from "../services/registration-invitations.js";

/**
 * Only known invitation failures become display copy. An arbitrary `error`
 * query value (or a provider-supplied description) is never echoed as text.
 */
function invitationErrorMessage(error: string | undefined): string {
  switch (error) {
    case "INVITATION_EMAIL_MISMATCH":
      return "The account you signed in with does not match the invited email address. Sign in with the invited address instead.";
    case "INVITATION_INVALID":
    case "signup_disabled":
      return "This invitation is no longer valid. Ask an administrator to send a new one.";
    case "email_not_verified":
      return "Your email address is not verified yet. Verify it first, or use another sign-in method.";
    case "access_denied":
      return "You cancelled the sign-in, or the provider refused access.";
    default:
      return "";
  }
}

function errorRedirect(
  reply: FastifyReply,
  code: "INVITATION_INVALID" | "INVITATION_EXPIRED",
  appSlug?: string,
) {
  const params = new URLSearchParams({ error: code });
  if (appSlug) params.set("client_id", appSlug);
  return reply.redirect(`/error?${params.toString()}`, 302);
}

function sendRenderFailure(
  fastify: FastifyInstance,
  reply: FastifyReply,
  page: string,
  appSlug: string | null,
  err: unknown,
) {
  fastify.log.error(
    { page, appSlug, err: err instanceof Error ? err.message : String(err) },
    "[templates] invitation page failed to render",
  );
  return reply
    .status(500)
    .header("content-type", "text/html; charset=utf-8")
    .send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Invitation unavailable</title><body><p>This invitation page is temporarily unavailable. Please try again later.</p></body></html>',
    );
}

function loginUrlFor(path: string): string {
  return `/login?redirectTo=${encodeURIComponent(path)}`;
}

/**
 * Public invitation landing pages.
 *
 * Organization invitations link to `/accept-invitation?id=…`; application
 * invitations link to `/complete-registration?token=…`. Both pages are always
 * server-rendered from the built-in templates, even when `TEMPLATES_DIR` is
 * unset: unlike the sign-in pages, they have no equivalent in the Vue SPA and
 * a missing route would turn every invitation link into a 404.
 */
export async function invitationPagesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/accept-invitation", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const invitationId = typeof query.id === "string" ? query.id.trim() : "";
    if (!invitationId) return errorRedirect(reply, "INVITATION_INVALID");

    const invitationRow = await findOrganizationInvitation(invitationId);
    if (!invitationRow) return errorRedirect(reply, "INVITATION_INVALID");

    const state = organizationInvitationState(invitationRow);
    if (state === "expired") return errorRedirect(reply, "INVITATION_EXPIRED");
    if (state !== "pending") return errorRedirect(reply, "INVITATION_INVALID");

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    const sessionEmail = session?.user.email ?? "";
    const sessionMatches =
      sessionEmail !== "" &&
      sessionEmail.trim().toLowerCase() ===
        invitationRow.email.trim().toLowerCase();
    const hasAccount = sessionEmail
      ? true
      : await hasAccountWithEmail(invitationRow.email);
    const path = `/accept-invitation?id=${encodeURIComponent(invitationRow.id)}`;

    try {
      const html = renderAuthPage(
        "accept-invitation",
        {
          actionUrl: "/api/registration/organization-invitation/complete",
          acceptUrl: "/api/registration/organization-invitation/accept",
          socialUrl: "/api/registration/organization-invitation/social",
          redirectTo: "",
          appSlug: "",
          authUrl: config.betterAuth.url,
          appName: config.appName,
          logoUrl: config.appLogoUrl ?? "",
          logoDarkUrl: config.appLogoDarkUrl ?? "",
          invitationKind: "organization",
          invitationId: invitationRow.id,
          targetName: invitationRow.organizationName,
          inviterName: invitationRow.inviterName ?? invitationRow.inviterEmail,
          invitationRole: invitationRow.role ?? "member",
          email: invitationRow.email,
          sessionEmail,
          sessionMatches,
          hasAccount,
          loginUrl: loginUrlFor(path),
          socialProvidersJson: JSON.stringify(globallyEnabledProviders()),
          errorMessage: invitationErrorMessage(query.error),
        },
        null,
        config.templatesDir,
      );
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .send(html);
    } catch (err) {
      return sendRenderFailure(fastify, reply, "accept-invitation", null, err);
    }
  });

  fastify.get("/complete-registration", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const token = typeof query.token === "string" ? query.token.trim() : "";
    if (!token) return errorRedirect(reply, "INVITATION_INVALID");

    const invitationRow = await findRegistrationInvitationByToken(token);
    if (!invitationRow) return errorRedirect(reply, "INVITATION_INVALID");

    const state = invitationState(invitationRow);
    if (state === "expired") return errorRedirect(reply, "INVITATION_EXPIRED");
    if (state !== "pending") return errorRedirect(reply, "INVITATION_INVALID");

    const [application] = await db
      .select({
        name: applications.name,
        slug: applications.slug,
        enabledSocialProviders: applications.enabledSocialProviders,
      })
      .from(applications)
      .where(eq(applications.id, invitationRow.applicationId))
      .limit(1);
    if (!application) return errorRedirect(reply, "INVITATION_INVALID");

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    const sessionEmail = session?.user.email ?? "";
    const sessionMatches =
      sessionEmail !== "" &&
      sessionEmail.trim().toLowerCase() ===
        invitationRow.email.trim().toLowerCase();
    const hasAccount = sessionEmail
      ? true
      : await hasAccountWithEmail(invitationRow.email);
    const path = `/complete-registration?token=${encodeURIComponent(token)}&client_id=${encodeURIComponent(application.slug)}`;
    const appSlug = application.slug;
    const socialProviders = socialProvidersFor(
      application.enabledSocialProviders,
    );

    try {
      // A provider round-trip lands here with a session. Render the shared
      // completion page (built-in fallback) so an older custom registration
      // template cannot show a form that would try to create a second account.
      if (sessionEmail !== "" || hasAccount) {
        const html = renderAuthPage(
          "accept-invitation",
          {
            actionUrl: "",
            acceptUrl: "/api/registration/application-invitation/accept",
            socialUrl: "/api/registration/application-invitation/social",
            redirectTo: "",
            appSlug,
            authUrl: config.betterAuth.url,
            appName: config.appName,
            logoUrl: config.appLogoUrl ?? "",
            logoDarkUrl: config.appLogoDarkUrl ?? "",
            invitationKind: "application",
            invitationToken: token,
            targetName: application.name,
            email: invitationRow.email,
            sessionEmail,
            sessionMatches,
            hasAccount,
            loginUrl: loginUrlFor(path),
            socialProvidersJson: JSON.stringify(socialProviders),
            errorMessage: invitationErrorMessage(query.error),
          },
          appSlug,
          config.templatesDir,
        );
        return reply
          .status(200)
          .header("content-type", "text/html; charset=utf-8")
          .send(html);
      }

      const html = renderAuthPage(
        "complete-registration",
        {
          actionUrl: "/api/registration/complete",
          socialUrl: "/api/registration/application-invitation/social",
          redirectTo: "",
          appSlug,
          authUrl: config.betterAuth.url,
          appName: config.appName,
          logoUrl: config.appLogoUrl ?? "",
          logoDarkUrl: config.appLogoDarkUrl ?? "",
          targetName: application.name,
          email: invitationRow.email,
          invitationToken: token,
          loginUrl: loginUrlFor(path),
          socialProvidersJson: JSON.stringify(socialProviders),
          errorMessage: invitationErrorMessage(query.error),
        },
        appSlug,
        config.templatesDir,
      );
      return reply
        .status(200)
        .header("content-type", "text/html; charset=utf-8")
        .send(html);
    } catch (err) {
      return sendRenderFailure(
        fastify,
        reply,
        "complete-registration",
        appSlug,
        err,
      );
    }
  });
}
