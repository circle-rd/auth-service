import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { twoFactor, admin, jwt, role, organization } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
import { db } from "./db/index.js";
import * as customSchema from "./db/schema.js";
import * as authSchema from "./db/auth-schema.js";
import { applications } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { getUserClaims, userHasAppAccessBySlug } from "./services/claims.js";
import {
  sendResetPasswordEmail,
  sendVerificationEmail,
} from "./services/email.js";
import { APIError } from "better-auth";

const schema = { ...authSchema, ...customSchema };

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: config.betterAuth.secret,
  baseURL: config.betterAuth.url,
  // Let BetterAuth trust all configured CORS origins
  trustedOrigins: config.cors.origins,
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
    requireEmailVerification: false,
    sendResetPassword: async (params: {
      user: { email: string };
      url: string;
    }) => {
      await sendResetPasswordEmail(params.user.email, params.url);
    },
    sendVerificationEmail: async (params: {
      user: { email: string };
      url: string;
    }) => {
      await sendVerificationEmail(params.user.email, params.url);
    },
  },
  user: {
    additionalFields: {
      isMfaRequired: {
        type: "boolean",
        defaultValue: false,
        required: false,
      },
      phone: { type: "string", required: false },
      company: { type: "string", required: false },
      position: { type: "string", required: false },
      address: { type: "string", required: false },
    },
  },
  plugins: [
    // Required for asymmetric JWT signing used by oauthProvider.
    // Set an explicit issuer so both the jwt plugin and oauthProvider's
    // createIdToken use the same value (config.betterAuth.url without '/api/auth').
    // Without this, createIdToken falls back to ctx.context.baseURL which
    // BetterAuth computes as `${baseURL}/api/auth`, causing iss/issuer mismatch.
    jwt({ jwt: { issuer: config.betterAuth.url } }),
    twoFactor(),
    passkey(),
    // Organization support — only admins can create orgs via admin API.
    // Regular users can be members of orgs but cannot create them.
    organization({
      allowUserToCreateOrganization: false,
    }),
    admin({
      adminRoles: ["admin", "superadmin"],
      defaultRole: "user",
      roles: {
        user: role({}),
        admin: role({
          user: [
            "create",
            "list",
            "set-role",
            "ban",
            "impersonate",
            "delete",
            "set-password",
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
            "set-password",
            "get",
            "update",
          ],
          session: ["list", "revoke", "delete"],
        }),
      },
    }),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/oauth2/consent",
      // Valid resource server audiences for JWT access tokens (RFC 8707).
      // When empty, BetterAuth defaults to the base URL as the audience.
      // Clients must include `resource=<url>` in auth/token requests to
      // receive a JWT; without it they receive an opaque token instead.
      ...(config.oauthProvider.validAudiences.length > 0
        ? { validAudiences: config.oauthProvider.validAudiences }
        : {}),
      scopes: [
        "openid",
        "profile",
        "email",
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
      // Also gates token issuance: throws FORBIDDEN if user has no access to the app
      // or if the application requires MFA and the user has not enabled it.
      customIdTokenClaims: async ({ user, scopes, metadata }) => {
        // metadata.clientId is stored in oauthClient.metadata and equals applications.slug
        const clientId = (metadata as Record<string, unknown> | undefined)
          ?.clientId as string | undefined;
        if (clientId) {
          const hasAccess = await userHasAppAccessBySlug(user.id, clientId);
          if (!hasAccess) {
            throw new APIError("FORBIDDEN", {
              message: "User not authorized for this application",
            });
          }

          // Enforce MFA when the application requires it.
          // Look up the application by slug to check isMfaRequired.
          const [app] = await db
            .select({ isMfaRequired: applications.isMfaRequired })
            .from(applications)
            .where(eq(applications.slug, clientId))
            .limit(1);

          if (app?.isMfaRequired) {
            const userRecord = user as Record<string, unknown>;
            const hasMfaEnabled = Boolean(userRecord.twoFactorEnabled);
            if (!hasMfaEnabled) {
              // User has not set up MFA but the application requires it.
              throw new APIError("FORBIDDEN", {
                message:
                  "This application requires MFA. Please enable two-factor authentication in your profile before continuing.",
              });
            }
            // If MFA is enabled, the twoFactor plugin's sign-in hook already
            // enforced verification during login — no additional check needed here.
          }
        }
        return getUserClaims(user.id, clientId, scopes, {
          email: (user as Record<string, unknown>).email as string | null | undefined,
          name: (user as Record<string, unknown>).name as string | null | undefined,
        });
      },
      // Inject claims into the OAuth2 access token JWT (verified by ioserver-oidc).
      // `customIdTokenClaims` only affects the ID token; this callback is what
      // puts roles/permissions/features/email/name/org_id in the Bearer JWT that
      // the resource server (MCP-Central, CyPlate, etc.) receives and verifies.
      // `resource` is the RFC 8707 audience URL (e.g. "https://api.lagarde.dev").
      // `referenceId` is the org ID stored at consent time via postLogin flow.
      // `metadata.clientId` holds the OAuth client slug (application slug).
      customAccessTokenClaims: async ({ user, scopes, metadata, referenceId }) => {
        // `user` is null for client_credentials grants (machine-to-machine)
        if (!user) return {};
        const clientId = (metadata as Record<string, unknown> | undefined)
          ?.clientId as string | undefined;
        const claims = await getUserClaims(user.id, clientId, scopes, {
          email: (user as Record<string, unknown>).email as string | null | undefined,
          name: (user as Record<string, unknown>).name as string | null | undefined,
        });
        // Inject org_id when the client requested the "org" scope and a
        // reference (activeOrganizationId) was captured during the postLogin flow.
        if (scopes.includes("org") && referenceId) {
          (claims as Record<string, unknown>).org_id = referenceId;
        }
        return claims;
      },
      // Same data in /oauth2/userinfo response.
      // clientId is read from the access token's azp (authorized party) claim.
      customUserInfoClaims: async ({ user, scopes, jwt }) => {
        const clientId = (jwt as Record<string, unknown>)?.azp as
          | string
          | undefined;
        return getUserClaims(user.id, clientId, scopes, {
          email: (user as Record<string, unknown>).email as string | null | undefined,
          name: (user as Record<string, unknown>).name as string | null | undefined,
        });
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
            orgs[0]?.id === (session as Record<string, unknown>)?.activeOrganizationId
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
