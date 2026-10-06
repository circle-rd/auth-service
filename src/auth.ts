import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  twoFactor,
  admin,
  jwt,
  role,
  organization,
  magicLink,
  emailOTP,
  haveIBeenPwned,
  captcha,
  lastLoginMethod,
  deviceAuthorization,
} from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
import { db } from "./db/index.js";
import * as customSchema from "./db/schema.js";
import * as authSchema from "./db/auth-schema.js";
import { applications, userApplications } from "./db/schema.js";
import { and, eq } from "drizzle-orm";
import { config } from "./config.js";
import { trustedOrigins } from "./runtime-config.js";
import { logger } from "./logger.js";
import {
  getUserClaims,
  userHasAppAccessBySlug,
  assignDefaultRoleIfNeeded,
  assignDefaultPlanIfNeeded,
} from "./services/claims.js";
import {
  sendResetPasswordEmail,
  sendVerificationEmail,
  sendChangeEmailVerification,
  sendMagicLinkEmail,
  sendEmailOtp,
  sendOrganizationInvitationEmail,
} from "./services/email.js";
import { userMustSetupMfa } from "./services/mfa.js";
import { isSocialProviderAllowed } from "./services/social-providers.js";
import { recordLogin } from "./services/login-history.js";
import { canManageRole } from "./services/roles.js";
import { createAuthMiddleware } from "better-auth/api";
import { APIError } from "better-auth";
import { deleteSessionCookie } from "better-auth/cookies";
import {
  CONFIRMATION_STATUSES,
  EMAIL_VERIFIED_PATH,
  type ConfirmationStatus,
} from "./services/templates.js";

const schema = { ...authSchema, ...customSchema };

/** The status a confirmation callback marks, or null when it is not one of ours. */
function confirmationStatusOf(
  callbackURL: string | null,
): ConfirmationStatus | null {
  if (!callbackURL?.startsWith(`${EMAIL_VERIFIED_PATH}?`)) return null;
  const value = new URLSearchParams(
    callbackURL.slice(EMAIL_VERIFIED_PATH.length + 1),
  ).get("status");
  return CONFIRMATION_STATUSES.find((status) => status === value) ?? null;
}

/** The `client_id` an OAuth or confirmation callback carries, if any. */
function clientIdOf(callbackURL: string | null): string | null {
  if (!callbackURL) return null;
  try {
    return new URL(callbackURL, config.betterAuth.url).searchParams.get(
      "client_id",
    );
  } catch {
    return null;
  }
}

/**
 * Point the `callbackURL` of a verification link at the confirmation page
 * instead of an authenticated area.
 *
 * The target is always replaced — a verification click must never land in a
 * protected area, and this service owns the post-verification landing for every
 * flow it drives. `resolve` receives the status the link already marks (null on
 * a first-leg link) and answers the status to write, so the change-email leg can
 * tell its two hops apart. A `client_id` carried by the previous callback is
 * preserved so the page still resolves that application's own template. An
 * unparseable URL is returned untouched rather than guessed at.
 */
function withConfirmationCallback(
  url: string,
  resolve: (marked: ConfirmationStatus | null) => ConfirmationStatus,
): string {
  try {
    const parsed = new URL(url);
    const previous = parsed.searchParams.get("callbackURL");

    const params = new URLSearchParams({
      status: resolve(confirmationStatusOf(previous)),
    });
    const clientId = clientIdOf(previous);
    if (clientId) params.set("client_id", clientId);
    parsed.searchParams.set("callbackURL", `${EMAIL_VERIFIED_PATH}?${params}`);
    return parsed.toString();
  } catch {
    return url;
  }
}

const ADMIN_TARGET_USER_ID_PATHS = new Set([
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/remove-user",
  "/admin/update-user",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/impersonate-user",
  "/admin/revoke-user-sessions",
]);

/**
 * Resolve the user id targeted by a native BetterAuth admin endpoint, or null
 * when the request is not one of the guarded endpoints. `revoke-user-session`
 * identifies the session by token, so the owner is resolved from the session
 * table.
 */
async function resolveAdminTargetUserId(
  path: string,
  body: unknown,
): Promise<string | null> {
  if (ADMIN_TARGET_USER_ID_PATHS.has(path)) {
    const userId = (body as Record<string, unknown> | undefined)?.userId;
    return typeof userId === "string" ? userId : null;
  }
  if (path === "/admin/revoke-user-session") {
    const sessionToken = (body as Record<string, unknown> | undefined)
      ?.sessionToken;
    if (typeof sessionToken !== "string") return null;
    const [row] = await db
      .select({ userId: authSchema.session.userId })
      .from(authSchema.session)
      .where(eq(authSchema.session.token, sessionToken))
      .limit(1);
    return row?.userId ?? null;
  }
  return null;
}

/**
 * Reserved JWT claim names (mirror of admin route validation). Any per-app
 * metadata key matching one of these is silently dropped at injection time as
 * a defence-in-depth measure: even if an admin bypassed the input validator,
 * we never let user-provided values shadow OAuth-managed claims.
 */
const RESERVED_JWT_CLAIMS = new Set([
  "sub",
  "aud",
  "iss",
  "exp",
  "iat",
  "nbf",
  "jti",
  "scope",
  "scopes",
  "azp",
  "client_id",
  "token_type",
  "auth_time",
  "acr",
  "amr",
  "client_attrs",
]);

/**
 * Resolve and sanitise the per-application metadata for a given client slug,
 * returning a JWT fragment of the shape `{ client_attrs: { ... } }` ready to
 * be merged into the access / id / userinfo token.
 *
 * The fragment is empty (no `client_attrs` field at all) when the slug is
 * missing, the application does not exist, or its metadata is empty — so we
 * never emit a noisy empty object.
 *
 * String-typed values only: this matches EMQX 5's JWT → client_attrs contract
 * ("both keys and values must be of string type"), which is the de-facto
 * convention for resource servers that consume per-client attributes.
 */
async function getApplicationMetadataClaims(
  clientId: string | undefined,
): Promise<Record<string, unknown>> {
  if (!clientId) return {};
  const [row] = await db
    .select({ metadata: applications.metadata })
    .from(applications)
    .where(eq(applications.slug, clientId))
    .limit(1);
  const meta = (row?.metadata ?? {}) as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (RESERVED_JWT_CLAIMS.has(k)) continue;
    if (typeof v === "string") attrs[k] = v;
  }
  if (Object.keys(attrs).length === 0) return {};
  return { client_attrs: attrs };
}

/**
 * Fail-closed check for machine-to-machine tokens (client_credentials): the
 * request has no user, so the main access guard never runs. Reject unknown or
 * disabled applications outright.
 */
async function assertApplicationActive(
  clientId: string | undefined,
): Promise<void> {
  if (!clientId) {
    throw new APIError("FORBIDDEN", {
      message: "Token requested by an unregistered OAuth client",
    });
  }
  const [app] = await db
    .select({ isActive: applications.isActive })
    .from(applications)
    .where(eq(applications.slug, clientId))
    .limit(1);
  if (!app || !app.isActive) {
    throw new APIError("FORBIDDEN", {
      message: "Application not found or disabled",
    });
  }
}

/**
 * Central authorization guard for OAuth token issuance.
 *
 * MUST be invoked on EVERY token-issuance path that produces a user-bound
 * token — not just the OIDC id_token. The OAuth provider only calls
 * `customIdTokenClaims` (and therefore the gating that used to live inside it)
 * when the `openid` scope is present; a client that requests a JWT access
 * token with a valid `resource` but WITHOUT `openid` would otherwise bypass
 * every check below (revoked access, missing access, MFA, social-provider
 * allow-list). Calling this from both `customIdTokenClaims` and
 * `customAccessTokenClaims` closes that gap.
 *
 * Throws `APIError("FORBIDDEN")` to abort token issuance when the user is not
 * permitted. Auto-provisions access for public / open-registration apps,
 * mirroring the historical id-token behaviour.
 */
async function enforceApplicationAccessGuard(
  user: Record<string, unknown> & { id: string },
  clientId: string | undefined,
): Promise<void> {
  // Fail closed: every user-bound token must be tied to a registered OAuth
  // client. A missing client id means the caller (or the client) is not one of
  // our applications, so no application-level policy can be evaluated and no
  // token may be issued.
  if (!clientId) {
    throw new APIError("FORBIDDEN", {
      message: "Token requested by an unregistered OAuth client",
    });
  }

  // A banned account must not receive or renew tokens, including through the
  // refresh_token grant (which otherwise keeps minting access tokens forever).
  if (user.banned === true) {
    throw new APIError("FORBIDDEN", { message: "Account is disabled" });
  }

  // Single query: resolve app + the flags needed for the access decision.
  const [app] = await db
    .select({
      id: applications.id,
      isActive: applications.isActive,
      isPublic: applications.isPublic,
      allowRegister: applications.allowRegister,
      isMfaRequired: applications.isMfaRequired,
      enabledSocialProviders: applications.enabledSocialProviders,
    })
    .from(applications)
    .where(eq(applications.slug, clientId))
    .limit(1);

  if (!app || !app.isActive) {
    throw new APIError("FORBIDDEN", {
      message: "Application not found or disabled",
    });
  }

  const hasAccess = await userHasAppAccessBySlug(user.id, clientId);
  if (!hasAccess) {
    // Distinguish "never had access" from "explicitly revoked" (isActive: false).
    // A revoked row must not be re-activated by auto-provisioning.
    const [existingRow] = await db
      .select({ isActive: userApplications.isActive })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, user.id),
          eq(userApplications.applicationId, app.id),
        ),
      )
      .limit(1);

    if (existingRow) {
      // Row exists but isActive is false → access explicitly revoked.
      throw new APIError("FORBIDDEN", {
        message: "User access has been revoked for this application",
      });
    }

    if (app.isPublic || app.allowRegister) {
      // Auto-provision: insert a userApplications row so subsequent calls
      // find the user as an active member of this application.
      await db
        .insert(userApplications)
        .values({
          userId: user.id,
          applicationId: app.id,
          isActive: true,
        })
        .onConflictDoNothing();
      await assignDefaultRoleIfNeeded(user.id, app.id);
      await assignDefaultPlanIfNeeded(user.id, app.id);
    } else {
      throw new APIError("FORBIDDEN", {
        message: "User not authorized for this application",
      });
    }
  }

  // Enforce MFA when the application requires it OR when the user has been
  // individually flagged as MFA-required by an admin. The OAuth token cannot
  // be issued until the user enables a second factor.
  if (userMustSetupMfa(user, Boolean(app.isMfaRequired))) {
    throw new APIError("FORBIDDEN", {
      message:
        "MFA is required for this account. Please enable two-factor authentication in your profile before continuing.",
    });
  }
  // If MFA is enabled, the twoFactor plugin's sign-in hook already enforced
  // verification during login — no additional check needed here.

  // Per-app social provider gate. If the application restricts the set of
  // allowed social providers and the user's primary linked account is not in
  // that list, deny token issuance.
  const accounts = await db
    .select({ providerId: authSchema.account.providerId })
    .from(authSchema.account)
    .where(eq(authSchema.account.userId, user.id));
  // A user is allowed if at least one of their linked accounts is permitted.
  const allowed = accounts.some((a) =>
    isSocialProviderAllowed(app.enabledSocialProviders, a.providerId),
  );
  if (accounts.length > 0 && !allowed) {
    throw new APIError("FORBIDDEN", {
      message: "Social provider not enabled for this application",
    });
  }
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: config.betterAuth.secret,
  baseURL: config.betterAuth.url,
  // Used as the default TOTP issuer (shown in authenticator apps) and as a
  // display name in other BetterAuth contexts.
  appName: config.appName,
  // Live mutable list — seeded from env + DB app URLs at startup,
  // updated on application create/update/delete without restart.
  trustedOrigins: trustedOrigins,
  // Enable cross-subdomain cookies when SESSION_DOMAIN is configured (e.g. "example.com")
  ...(config.session.domain
    ? {
        advanced: {
          crossSubDomainCookies: {
            enabled: true,
            domain: config.session.domain,
          },
        },
      }
    : {}),
  // Disable built-in /token route — /oauth2/token is used instead
  disabledPaths: ["/token"],
  // Social login providers — only enabled when both CLIENT_ID and CLIENT_SECRET are set
  socialProviders: {
    ...(config.providers.google.enabled
      ? {
          google: {
            clientId: config.providers.google.clientId as string,
            clientSecret: config.providers.google.clientSecret as string,
          },
        }
      : {}),
    ...(config.providers.github.enabled
      ? {
          github: {
            clientId: config.providers.github.clientId as string,
            clientSecret: config.providers.github.clientSecret as string,
          },
        }
      : {}),
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: config.email.requireVerification,
    sendResetPassword: async (params: {
      user: { email: string };
      url: string;
    }) => {
      await sendResetPasswordEmail(params.user.email, params.url);
    },
  },
  // BetterAuth wires the verification email sender at the top level under
  // `emailVerification` (NOT inside `emailAndPassword` — that field is
  // silently ignored). `sendOnSignUp: true` fires the email automatically
  // when a new account is created.
  //
  // `autoSignInAfterVerification` is off: a verification link must never be a
  // bearer credential. Without it, anyone who can read the mailbox (a forward,
  // a backup, a shared workstation, a leak) would obtain a fully authenticated
  // session without ever presenting the password or a second factor. The click
  // only proves control of the address; it lands on a confirmation page, and
  // reaching a protected area still requires an explicit sign-in.
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async (params: {
      user: { email: string };
      url: string;
    }) => {
      await sendVerificationEmail(
        params.user.email,
        withConfirmationCallback(params.url, (marked) =>
          // The change-of-address flow's second hop comes back through this
          // same sender (BetterAuth mails it to the new address). A link that
          // already reported `pending` is therefore completing a change, not
          // activating a new account.
          marked === "pending" ? "updated" : "activated",
        ),
      );
    },
  },
  // Email change confirmation: BetterAuth fires this when an authenticated
  // user updates their email. The link goes to the user's CURRENT address;
  // they must click it to finalise the change to `newEmail`.
  user: {
    changeEmail: {
      enabled: true,
      // BetterAuth 1.6 renamed this callback from
      // `sendChangeEmailVerification` to `sendChangeEmailConfirmation`.
      // The old name is silently ignored by the runtime.
      sendChangeEmailConfirmation: async (params: {
        user: { email: string };
        newEmail: string;
        url: string;
      }) => {
        // The change-of-address flow is two hops over the same endpoint: the
        // first confirms the request and mails the new address, the second
        // completes the swap. `pending` and `updated` keep them apart, because
        // only the second one leaves a verified address behind.
        await sendChangeEmailVerification(
          params.user.email,
          params.newEmail,
          withConfirmationCallback(params.url, () => "pending"),
        );
      },
    },
    additionalFields: {
      // Server-controlled: set by admins through /api/admin/users, never by the
      // user themselves. `input: false` strips it from /update-user payloads so
      // a user cannot lift an MFA requirement imposed on them.
      isMfaRequired: {
        type: "boolean",
        defaultValue: false,
        required: false,
        input: false,
      },
      phone: { type: "string", required: false },
      company: { type: "string", required: false },
      position: { type: "string", required: false },
      address: { type: "string", required: false },
      // Surfaced to admin listings as "last seen". Written by
      // services/login-history.ts; must not be user-writable.
      lastLoginAt: { type: "date", required: false, input: false },
    },
  },
  // Capture every direct session creation (admin dashboard sign-in, password
  // login, social provider callback) as a login_history row with
  // applicationId = null. OAuth-client logins are already recorded inside
  // `customAccessTokenClaims` with the resolved applicationId — those rows
  // are complementary (one per token issuance, with an app id and IP/UA
  // from the OAuth context). Fire-and-forget: failures must never break
  // session creation.
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          try {
            const s = session as {
              userId: string;
              id: string;
              ipAddress?: string | null;
              userAgent?: string | null;
            };
            await recordLogin({
              userId: s.userId,
              applicationId: null,
              sessionId: s.id,
              ipAddress: s.ipAddress ?? null,
              userAgent: s.userAgent ?? null,
            });
          } catch (err) {
            logger.warn(
              { err: String(err) },
              "[login-history] failed to record dashboard login",
            );
          }
        },
      },
    },
  },
  // Hierarchy guard for the native BetterAuth admin endpoints. The admin role
  // holds `ban`/`update`/`session:revoke` permissions (needed by our own
  // controlled routes), but nothing stops a direct call to
  // /api/auth/admin/* from targeting a peer or a superadmin. This hook rejects
  // any admin action whose target outranks (or equals) the caller.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const targetUserId = await resolveAdminTargetUserId(ctx.path, ctx.body);
      if (!targetUserId) return;

      if (!ctx.headers) return;
      const session = await auth.api.getSession({ headers: ctx.headers });
      // Unauthenticated callers are rejected by the endpoint itself.
      if (!session) return;

      const callerRole =
        ((session.user as Record<string, unknown>).role as
          string | undefined) ?? "user";
      const [target] = await db
        .select({ role: authSchema.user.role })
        .from(authSchema.user)
        .where(eq(authSchema.user.id, targetUserId))
        .limit(1);
      if (!target) return;

      if (!canManageRole(callerRole, target.role ?? "user")) {
        throw new APIError("FORBIDDEN", {
          message: "Cannot manage a user with an equal or higher role",
        });
      }
    }),
    // The two-factor plugin only challenges the password sign-in flow. Social,
    // magic-link and email-OTP sign-ins would otherwise create a fully
    // authenticated session for a 2FA-enabled account, silently bypassing the
    // second factor. Fail closed: drop the session and require the
    // password + second-factor flow instead. Passkey is deliberately excluded
    // (a passkey is already a strong, possession-based factor).
    after: createAuthMiddleware(async (ctx) => {
      // A verification click must never hand out a session. BetterAuth's
      // `change-email-verification` branch mints one unconditionally — unlike
      // the sign-up path it is NOT governed by `autoSignInAfterVerification` —
      // so revoke whatever this endpoint created for a caller that arrived
      // without a session. A caller that already had one keeps it: the endpoint
      // re-issues that same session there, and dropping it would sign the user
      // out of a session they legitimately hold.
      if (ctx.path === "/verify-email") {
        const minted = ctx.context.newSession;
        if (minted && !ctx.context.session) {
          deleteSessionCookie(ctx);
          await ctx.context.internalAdapter.deleteSession(minted.session.token);
          ctx.context.setNewSession(null);
        }
      }

      const passwordlessSignInPaths = [
        "/callback/",
        "/magic-link/verify",
        "/sign-in/email-otp",
        "/email-otp/verify-email",
        "/one-tap/callback",
        // Social sign-in creates a session directly in its `idToken` branch
        // (native-app flow); include it so that path cannot skip 2FA either.
        "/sign-in/social",
      ];
      if (!passwordlessSignInPaths.some((p) => ctx.path.startsWith(p))) return;

      const newSession = ctx.context.newSession;
      if (!newSession) return;
      if (newSession.user.twoFactorEnabled !== true) return;

      await ctx.context.internalAdapter.deleteSession(newSession.session.token);
      ctx.context.setNewSession(null);
      throw new APIError("FORBIDDEN", {
        message:
          "This account has two-factor authentication enabled. Sign in with your password and a second factor.",
      });
    }),
  },
  plugins: [
    // Required for asymmetric JWT signing used by oauthProvider.
    // Set an explicit issuer so both the jwt plugin and oauthProvider's
    // createIdToken use the same value (config.betterAuth.url without '/api/auth').
    // Without this, createIdToken falls back to ctx.context.baseURL which
    // BetterAuth computes as `${baseURL}/api/auth`, causing iss/issuer mismatch.
    jwt({
      jwt: { issuer: config.betterAuth.url },
      // Do not emit a `set-auth-jwt` response header on get-session: that JWT
      // is signed with the same JWKS keys as OAuth access tokens and can be
      // mistaken for one by downstream resource servers. Bearer tokens must
      // come from the token endpoint.
      disableSettingJwtHeader: true,
      // Rotate signing keys monthly; keep the previous key for a month so
      // access tokens issued just before rotation still verify.
      jwks: {
        rotationInterval: 60 * 60 * 24 * 30,
        gracePeriod: 60 * 60 * 24 * 30,
      },
    }),
    twoFactor({ issuer: config.appName }),
    passkey(),
    // ── Optional Phase 5b plugins (opt-in via env) ──────────────────────────
    // Every entry below is gated so the default deployment stays identical.
    ...(config.features.haveIBeenPwned ? [haveIBeenPwned()] : []),
    ...(config.features.lastLoginMethod ? [lastLoginMethod()] : []),
    ...(config.captcha.enabled
      ? [
          captcha({
            provider: config.captcha.provider as
              | "cloudflare-turnstile"
              | "google-recaptcha"
              | "hcaptcha"
              | "captchafox",
            secretKey: config.captcha.secretKey as string,
            siteKey: config.captcha.siteKey,
            ...(config.captcha.endpoints
              ? { endpoints: config.captcha.endpoints }
              : {}),
          } as Parameters<typeof captcha>[0]),
        ]
      : []),
    ...(config.features.deviceAuthorization
      ? [deviceAuthorization({ verificationUri: "/device" })]
      : []),
    // Organization support — only admins/superadmins can create orgs via admin API.
    // Regular users can be members of orgs but cannot create them.
    organization({
      allowUserToCreateOrganization: async (user) => {
        const role = (user as Record<string, unknown>).role as
          string | undefined;
        return role === "admin" || role === "superadmin";
      },
      // Email an invited user the accept-invitation link. Falls back
      // gracefully if the invitation row is missing some optional fields.
      sendInvitationEmail: async (data: {
        id: string;
        email: string;
        role?: string;
        organization: { name: string; slug?: string };
        inviter: { user: { name?: string | null; email: string } };
      }) => {
        const acceptUrl = `${config.betterAuth.url}/accept-invitation?id=${encodeURIComponent(
          data.id,
        )}`;
        await sendOrganizationInvitationEmail(data.email, {
          url: acceptUrl,
          inviterName: data.inviter.user.name || data.inviter.user.email,
          orgName: data.organization.name,
          role: data.role,
        });
      },
    }),
    admin({
      adminRoles: ["admin", "superadmin"],
      defaultRole: "user",
      roles: {
        user: role({}),
        // Admins can list/get/create users and manage sessions, but CANNOT set roles
        // or change passwords via the native BetterAuth admin API. Those operations
        // go through our custom routes which enforce the role hierarchy.
        //
        // `set-password` is withheld from BOTH admin and superadmin: the native
        // endpoint writes the credential without revoking the target's sessions,
        // which defeats a password reset on a compromised account. The only
        // supported path is `POST /api/admin/users/:id/set-password`, which does
        // both in one operation.
        admin: role({
          user: [
            "create",
            "list",
            "ban",
            "impersonate",
            "delete",
            "get",
            "update",
          ],
          session: ["list", "revoke", "delete"],
        }),
        superadmin: role({
          user: [
            "create",
            "list",
            "set-role",
            "ban",
            "impersonate",
            "impersonate-admins",
            "delete",
            "get",
            "update",
          ],
          session: ["list", "revoke", "delete"],
        }),
      },
    }),
    // Passwordless flows — gated by env so deployments that don't want them
    // never expose the corresponding endpoints. Both are sender-only here;
    // verification (/api/auth/magic-link/verify, /api/auth/email-otp/...) is
    // always reachable on the BetterAuth client side.
    ...(config.email.magicLinkEnabled
      ? [
          magicLink({
            // Store a hash of the token instead of the plaintext so a leaked
            // database dump cannot be replayed to sign in.
            storeToken: "hashed",
            sendMagicLink: async (params: { email: string; url: string }) => {
              await sendMagicLinkEmail(params.email, params.url);
            },
          }),
        ]
      : []),
    ...(config.email.otpEnabled
      ? [
          emailOTP({
            sendVerificationOTP: async (params: {
              email: string;
              otp: string;
              type:
                | "sign-in"
                | "email-verification"
                | "forget-password"
                | "change-email";
            }) => {
              await sendEmailOtp(params.email, params.otp, params.type);
            },
          }),
        ]
      : []),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/oauth2/consent",
      // Restrict the native OAuth client management endpoints
      // (/oauth2/create-client, /update-client, /delete-client, /rotate-secret,
      // /client/...). Without this, ANY authenticated account could register its
      // own client and obtain tokens that bypass every application policy
      // (access, MFA, social provider allow-list). Clients are provisioned
      // exclusively through the admin API.
      clientPrivileges: ({ user }) => {
        const role = (user as Record<string, unknown> | undefined)?.role as
          string | undefined;
        return role === "admin" || role === "superadmin";
      },
      // Protected OAuth resources (RFC 8707 audiences) live in the
      // `oauth_resource` table, synced from applications.url by
      // services/oauth-resources.ts, and linked to their client via
      // `oauth_client_resource`.
      scopes: [
        "openid",
        "profile",
        "email",
        "phone",
        "offline_access",
        "roles",
        "permissions",
        "features",
        // org — injects org_id (activeOrganizationId) as a claim in the access token.
        // Clients that need org-scoped data should request this scope and include
        // `resource=<audience>` to receive a JWT (RFC 8707).
        "org",
      ],
      // Inject roles, permissions, features, and org_id into id_token.
      // Also gates token issuance:
      //   - throws FORBIDDEN when the user has no access AND the app is neither
      //     public nor open to registration
      //   - auto-provisions a userApplications row for new users on public apps
      //     or apps with allowRegister=true (their first token exchange)
      customIdTokenClaims: async ({ user, scopes, metadata }) => {
        // metadata.clientId is stored in oauthClient.metadata and equals applications.slug
        const clientId = (metadata as Record<string, unknown> | undefined)
          ?.clientId as string | undefined;
        // Shared authorization guard — also invoked in customAccessTokenClaims
        // so the gating cannot be skipped by omitting the `openid` scope.
        await enforceApplicationAccessGuard(
          user as Record<string, unknown> & { id: string },
          clientId,
        );
        return {
          ...(await getUserClaims(user.id, clientId, scopes, {
            email: (user as Record<string, unknown>).email as
              string | null | undefined,
            emailVerified: (user as Record<string, unknown>).emailVerified as
              boolean | null | undefined,
            name: (user as Record<string, unknown>).name as
              string | null | undefined,
            company: (user as Record<string, unknown>).company as
              string | null | undefined,
            image: (user as Record<string, unknown>).image as
              string | null | undefined,
            phone: (user as Record<string, unknown>).phone as
              string | null | undefined,
            updatedAt: (user as Record<string, unknown>).updatedAt as
              Date | null | undefined,
          })),
          // Per-app metadata claims (additive; reserved keys are filtered).
          ...(await getApplicationMetadataClaims(clientId)),
        };
      },
      // `customIdTokenClaims` only affects the ID token; this callback is what
      // puts roles/permissions/features/email/name/org_id in the Bearer JWT that
      // a downstream resource server receives and verifies.
      // `resource` is the RFC 8707 audience URL (e.g. "https://api.lagarde.dev").
      // `referenceId` is the org ID stored at consent time via postLogin flow.
      // `metadata.clientId` holds the OAuth client slug (application slug).
      customAccessTokenClaims: async ({
        user,
        scopes,
        metadata,
        referenceId,
      }) => {
        const clientId = (metadata as Record<string, unknown> | undefined)
          ?.clientId as string | undefined;
        // Per-app metadata is injected for BOTH user-bound and
        // client_credentials grants under the JWT `client_attrs` field. For
        // machine-to-machine tokens this is the sole source of custom claims
        // (no user → no roles/permissions/features).
        const appAttrs = await getApplicationMetadataClaims(clientId);
        if (!user) {
          // client_credentials: no user to gate on, but the client itself must
          // be a known, enabled application.
          await assertApplicationActive(clientId);
          return appAttrs;
        }
        // Shared authorization guard. The OAuth provider issues a JWT access
        // token whenever a valid `resource` is supplied, REGARDLESS of whether
        // the `openid` scope (and therefore customIdTokenClaims) is present.
        // Running the guard here prevents revoked / unauthorized users and
        // users who have not satisfied the MFA / social-provider policy from
        // obtaining a token simply by omitting `openid`.
        await enforceApplicationAccessGuard(
          user as Record<string, unknown> & { id: string },
          clientId,
        );
        const claims = await getUserClaims(user.id, clientId, scopes, {
          email: (user as Record<string, unknown>).email as
            string | null | undefined,
          emailVerified: (user as Record<string, unknown>).emailVerified as
            boolean | null | undefined,
          name: (user as Record<string, unknown>).name as
            string | null | undefined,
          company: (user as Record<string, unknown>).company as
            string | null | undefined,
          image: (user as Record<string, unknown>).image as
            string | null | undefined,
          phone: (user as Record<string, unknown>).phone as
            string | null | undefined,
          updatedAt: (user as Record<string, unknown>).updatedAt as
            Date | null | undefined,
        });
        // Inject org_id when the client requested the "org" scope and a
        // reference (activeOrganizationId) was captured during the postLogin flow.
        if (scopes.includes("org") && referenceId) {
          (claims as Record<string, unknown>).org_id = referenceId;
        }
        // Record this token issuance as a login event for analytics / last-seen
        // tracking. Fire-and-forget — a failure here must never block token
        // issuance for the downstream client. The OAuth issuance callback does
        // not surface request headers, so ipAddress / userAgent stay null;
        // they remain available on the parent session row when needed.
        if (clientId) {
          const [appRow] = await db
            .select({ id: applications.id })
            .from(applications)
            .where(eq(applications.slug, clientId))
            .limit(1);
          if (appRow) {
            try {
              await recordLogin({ userId: user.id, applicationId: appRow.id });
            } catch (err) {
              logger.warn(
                { userId: user.id, clientId, err: String(err) },
                "[login-history] failed to record login",
              );
            }
          }
        }
        return { ...claims, ...appAttrs };
      },
      // Same data in /oauth2/userinfo response.
      // clientId is read from the access token's azp (authorized party) claim.
      customUserInfoClaims: async ({ user, scopes, jwt }) => {
        const clientId = (jwt as Record<string, unknown>)?.azp as
          string | undefined;
        return {
          ...(await getUserClaims(user.id, clientId, scopes, {
            email: (user as Record<string, unknown>).email as
              string | null | undefined,
            emailVerified: (user as Record<string, unknown>).emailVerified as
              boolean | null | undefined,
            name: (user as Record<string, unknown>).name as
              string | null | undefined,
            company: (user as Record<string, unknown>).company as
              string | null | undefined,
            image: (user as Record<string, unknown>).image as
              string | null | undefined,
            phone: (user as Record<string, unknown>).phone as
              string | null | undefined,
            updatedAt: (user as Record<string, unknown>).updatedAt as
              Date | null | undefined,
          })),
          ...(await getApplicationMetadataClaims(clientId)),
        };
      },
      // When the "org" scope is requested: after login, determine whether we need
      // to redirect the user to the org-selection page (postLogin flow).
      postLogin: {
        page: "/select-org",
        shouldRedirect: async ({ session, scopes, headers }) => {
          if (!scopes.includes("org")) return false;
          const organizations = await auth.api.listOrganizations({ headers });
          const orgs = organizations ?? [];
          // Skip redirect if the user has 0 orgs (nothing to select)
          // or exactly 1 org that is already set as active.
          if (orgs.length === 0) return false;
          if (
            orgs.length === 1 &&
            orgs[0]?.id ===
              (session as Record<string, unknown>)?.activeOrganizationId
          ) {
            return false;
          }
          return true;
        },
        consentReferenceId: ({ session, scopes }) => {
          if (!scopes.includes("org")) return undefined;
          const orgId = (session as Record<string, unknown>)
            ?.activeOrganizationId as string | undefined;
          if (!orgId) {
            throw new APIError("BAD_REQUEST", {
              message: "Please select an organization before continuing.",
            });
          }
          return orgId;
        },
      },
    }),
  ],
});

export type Auth = typeof auth;
