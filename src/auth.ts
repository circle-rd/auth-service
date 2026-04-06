import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { twoFactor, admin, jwt, role } from "better-auth/plugins";
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
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "roles",
        "permissions",
        "features",
      ],
      // Inject roles, permissions, and features into id_token.
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
        return getUserClaims(user.id, clientId, scopes);
      },
      // Same data in /oauth2/userinfo response.
      // clientId is read from the access token's azp (authorized party) claim.
      customUserInfoClaims: async ({ user, scopes, jwt }) => {
        const clientId = (jwt as Record<string, unknown>)?.azp as
          | string
          | undefined;
        return getUserClaims(user.id, clientId, scopes);
      },
    }),
  ],
});

export type Auth = typeof auth;
