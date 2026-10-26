import type { FastifyInstance, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { ERR } from "../errors.js";
import {
  INVITATION_FLOW_COOKIE,
  createInvitationFlowValue,
} from "../services/invitation-cookie.js";
import {
  completeOrganizationRegistration,
  findOrganizationInvitation,
  organizationInvitationState,
} from "../services/organization-invitations.js";
import {
  acceptApplicationInvitation,
  buildInvitationUrl,
  completeRegistration,
  findRegistrationInvitationByToken,
  invitationState,
} from "../services/registration-invitations.js";
import {
  globallyEnabledProviders,
  socialProvidersFor,
  type SocialProvider,
} from "./app-config.js";

// The email comes from the invitation row, never from the caller: an invitee
// must not be able to register a different address than the one the
// administrator vouched for.
const completeRegistrationSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200),
});

const completeOrganizationSchema = z.object({
  invitationId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200),
});

const acceptOrganizationSchema = z.object({
  invitationId: z.string().min(1).max(200),
});

const acceptApplicationSchema = z.object({
  token: z.string().min(20).max(200),
});

const socialProviderSchema = z.enum(["google", "github"]);

const organizationSocialSchema = z.object({
  invitationId: z.string().min(1).max(200),
  provider: socialProviderSchema,
});

const applicationSocialSchema = z.object({
  token: z.string().min(20).max(200),
  provider: socialProviderSchema,
});

/** Include the signed invitation flow on the internal auth API request. */
function withInvitationCookie(headers: Headers, value: string): Headers {
  const next = new Headers(headers);
  const current = next.get("cookie");
  const withoutStaleFlow = current
    ?.split(";")
    .map((part) => part.trim())
    .filter(
      (part) => part !== "" && !part.startsWith(`${INVITATION_FLOW_COOKIE}=`),
    )
    .join("; ");
  next.set(
    "cookie",
    withoutStaleFlow
      ? `${withoutStaleFlow}; ${INVITATION_FLOW_COOKIE}=${value}`
      : `${INVITATION_FLOW_COOKIE}=${value}`,
  );
  return next;
}

/**
 * Start a provider redirect with the signed invitation token on the internal
 * `/sign-in/social` request. The hook copies it into BetterAuth's server-trusted
 * OAuth state, which the callback uses to enforce the invited address. The
 * token is never stored in a browser cookie that a callback could omit.
 */
async function startSocialInvitation(
  reply: FastifyReply,
  headers: Headers,
  opts: {
    provider: SocialProvider;
    callbackUrl: string;
    flow: {
      kind: "organization" | "application";
      invitationId: string;
      email: string;
    };
  },
): Promise<FastifyReply> {
  const value = createInvitationFlowValue(opts.flow);
  const response = await auth.api.signInSocial({
    body: {
      provider: opts.provider,
      callbackURL: opts.callbackUrl,
      errorCallbackURL: opts.callbackUrl,
    },
    headers: withInvitationCookie(headers, value),
    asResponse: true,
  });

  const payload = (await response.json()) as {
    url?: unknown;
    message?: unknown;
  };
  if (!response.ok || typeof payload.url !== "string") {
    throw ERR.APP_001(
      typeof payload.message === "string"
        ? payload.message
        : "Could not start the social sign-in",
    );
  }

  // Only BetterAuth's own OAuth state cookie is returned. The invitation
  // itself rides inside that signed state, so no second cookie can be omitted
  // on the callback to bypass the email check.
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) reply.header("set-cookie", setCookies);
  return reply.send({ url: payload.url });
}

function assertVerified(session: {
  user: { email: string; emailVerified: boolean };
}): void {
  if (!session.user.emailVerified) {
    throw ERR.AUTH_015();
  }
}

export async function registrationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Public: the token is the credential. Redeemed once, inside the service.
  fastify.post(
    "/complete",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = completeRegistrationSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid registration details");

      const result = await completeRegistration(parsed.data);
      return reply.send({ ok: true, email: result.email });
    },
  );

  // Email/password registration from an organization invitation. The account
  // is created verified, added to the invited organization and the invitation
  // is consumed in one transaction.
  fastify.post(
    "/organization-invitation/complete",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = completeOrganizationSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid registration details");

      const result = await completeOrganizationRegistration(parsed.data);
      return reply.send({
        ok: true,
        email: result.email,
        organizationId: result.organizationId,
      });
    },
  );

  // Accept an organization invitation for an account that already exists (or
  // was just created by a social provider). Delegates to the organization
  // plugin so membership limits, roles and the active-organization cookie stay
  // consistent with every other accept path.
  fastify.post(
    "/organization-invitation/accept",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = acceptOrganizationSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid invitation details");

      const headers = fromNodeHeaders(req.headers);
      const session = await auth.api.getSession({ headers });
      if (!session) throw ERR.AUTH_001();
      assertVerified(session);

      const invitationRow = await findOrganizationInvitation(
        parsed.data.invitationId,
      );
      if (!invitationRow) throw ERR.AUTH_012();
      const state = organizationInvitationState(invitationRow);
      if (state === "expired")
        throw ERR.AUTH_012("This invitation has expired");
      if (state !== "pending") throw ERR.AUTH_012();
      if (
        invitationRow.email.trim().toLowerCase() !==
        session.user.email.trim().toLowerCase()
      ) {
        throw ERR.AUTH_014();
      }

      const response = await auth.api.acceptInvitation({
        body: { invitationId: invitationRow.id },
        headers,
        asResponse: true,
      });
      if (!response.ok) {
        throw ERR.AUTH_012("Could not accept this invitation");
      }
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) reply.header("set-cookie", setCookies);
      return reply.send(await response.json());
    },
  );

  // Accept an application invitation for an account created through a social
  // provider. The provider callback has already created the session; the
  // invitation token is still the proof that access was granted.
  fastify.post(
    "/application-invitation/accept",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = acceptApplicationSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid invitation details");

      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (!session) throw ERR.AUTH_001();
      assertVerified(session);

      const result = await acceptApplicationInvitation({
        token: parsed.data.token,
        userId: session.user.id,
        email: session.user.email,
      });
      return reply.send({
        ok: true,
        applicationId: result.applicationId,
        email: result.email,
      });
    },
  );

  // Start a social sign-up/sign-in for an organization invitation.
  fastify.post(
    "/organization-invitation/social",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = organizationSocialSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid invitation details");

      const invitationRow = await findOrganizationInvitation(
        parsed.data.invitationId,
      );
      if (!invitationRow) throw ERR.AUTH_012();
      const state = organizationInvitationState(invitationRow);
      if (state !== "pending") throw ERR.AUTH_012();
      if (
        !globallyEnabledProviders().includes(
          parsed.data.provider as SocialProvider,
        )
      ) {
        throw ERR.APP_006("This social provider is not enabled");
      }

      return startSocialInvitation(reply, fromNodeHeaders(req.headers), {
        provider: parsed.data.provider,
        callbackUrl: `${config.betterAuth.url}/accept-invitation?id=${encodeURIComponent(invitationRow.id)}`,
        flow: {
          kind: "organization",
          invitationId: invitationRow.id,
          email: invitationRow.email,
        },
      });
    },
  );

  // Start a social sign-up/sign-in for an application invitation.
  fastify.post(
    "/application-invitation/social",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = applicationSocialSchema.safeParse(req.body);
      if (!parsed.success) throw ERR.USR_003("Invalid invitation details");

      const invitationRow = await findRegistrationInvitationByToken(
        parsed.data.token,
      );
      if (!invitationRow) throw ERR.AUTH_012();
      const state = invitationState(invitationRow);
      if (state !== "pending") throw ERR.AUTH_012();

      const [application] = await db
        .select({
          slug: applications.slug,
          enabledSocialProviders: applications.enabledSocialProviders,
        })
        .from(applications)
        .where(eq(applications.id, invitationRow.applicationId))
        .limit(1);
      if (!application) throw ERR.APP_002();
      if (
        !socialProvidersFor(application.enabledSocialProviders).includes(
          parsed.data.provider as SocialProvider,
        )
      ) {
        throw ERR.APP_006();
      }

      const token = parsed.data.token;
      return startSocialInvitation(reply, fromNodeHeaders(req.headers), {
        provider: parsed.data.provider,
        callbackUrl: buildInvitationUrl(application.slug, token),
        flow: {
          kind: "application",
          invitationId: invitationRow.id,
          email: invitationRow.email,
        },
      });
    },
  );
}
