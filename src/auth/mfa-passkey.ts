import type { GenericEndpointContext } from "@better-auth/core";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { parseUserOutput } from "better-auth/db";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  account as accountTable,
  passkey as passkeyTable,
} from "../db/auth-schema.js";
import {
  checkMfaMethodRemoval,
  getMfaState,
  hasBackupCodes,
  reconcileMfaFlag,
} from "../services/mfa.js";
import {
  acquireUserLock,
  holdUserLock,
  releaseUserLock,
} from "../services/user-lock.js";

/**
 * Passkey as a second factor.
 *
 * BetterAuth's passkey plugin only implements primary authentication: its
 * verify endpoint always creates a session. This plugin completes the pending
 * two-factor state created by BetterAuth's `twoFactor` plugin instead, so a
 * passkey can satisfy the second factor without bypassing TOTP policy.
 *
 * Errors use BetterAuth's `APIError`, not the Fastify `ApiError` registry:
 * these handlers run inside the BetterAuth node handler, which serialises
 * `APIError` and never reaches the Fastify error handler.
 */

const TWO_FACTOR_COOKIE = "two_factor";
const CHALLENGE_COOKIE = "mfa-passkey-challenge";
const CHALLENGE_MAX_AGE_SECONDS = 300;

const MFA_ERRORS = {
  PENDING_NOT_FOUND: {
    code: "MFA_001",
    message: "No pending two-factor authentication was found",
  },
  PASSKEY_NOT_ENROLLED: {
    code: "MFA_002",
    message: "This account has no passkey registered",
  },
  CHALLENGE_NOT_FOUND: {
    code: "MFA_003",
    message: "The passkey challenge is missing or has expired",
  },
  CHALLENGE_INVALID: {
    code: "MFA_004",
    message: "The passkey challenge does not belong to this sign-in",
  },
  AUTHENTICATION_FAILED: {
    code: "MFA_005",
    message: "Passkey authentication failed",
  },
  ORIGIN_MISSING: {
    code: "MFA_006",
    message: "The request origin is missing",
  },
  USER_NOT_FOUND: {
    code: "MFA_007",
    message: "The pending user no longer exists",
  },
  SESSION_FAILED: {
    code: "MFA_008",
    message: "Could not create the authenticated session",
  },
  LAST_FACTOR_REQUIRED: {
    code: "MFA_009",
    message: "This is the last MFA method and MFA is required for this account",
  },
  LAST_AUTHENTICATION_METHOD: {
    code: "MFA_010",
    message: "This is the only remaining way to authenticate this account",
  },
  PASSWORD_REQUIRED: {
    code: "MFA_011",
    message: "Set a password before adding a passkey",
  },
} as const;

function baseURL(ctx: GenericEndpointContext): string {
  return typeof ctx.context.options.baseURL === "string"
    ? ctx.context.options.baseURL
    : config.betterAuth.url;
}

function rpID(ctx: GenericEndpointContext): string {
  return new URL(baseURL(ctx)).hostname;
}

function requestOrigin(ctx: GenericEndpointContext): string {
  return ctx.headers?.get("origin") ?? "";
}

function pinnedOrigin(
  ctx: GenericEndpointContext,
  requestOrigin: string,
): string {
  const configured = new URL(baseURL(ctx)).origin;
  try {
    const request = new URL(requestOrigin);
    if (request.origin === configured) return configured;
    // The Vite dev server proxies /api from a different port on the same host.
    if (config.isDev && request.hostname === new URL(configured).hostname) {
      return request.origin;
    }
  } catch {
    // fall through to the configured origin
  }
  return configured;
}

const AUTHENTICATOR_TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  "usb",
  "nfc",
  "ble",
  "internal",
  "hybrid",
  "smart-card",
]);

function parseTransports(
  value: string | null,
): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .filter((transport): transport is AuthenticatorTransportFuture =>
      AUTHENTICATOR_TRANSPORTS.has(transport as AuthenticatorTransportFuture),
    );
}

async function readPendingMfa(ctx: GenericEndpointContext) {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
  const token = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!token) {
    throw APIError.from("UNAUTHORIZED", MFA_ERRORS.PENDING_NOT_FOUND);
  }

  const verification =
    await ctx.context.internalAdapter.findVerificationValue(token);
  if (!verification) {
    throw APIError.from("UNAUTHORIZED", MFA_ERRORS.PENDING_NOT_FOUND);
  }

  const user = await ctx.context.internalAdapter.findUserById(
    verification.value,
  );
  if (!user) {
    throw APIError.from("UNAUTHORIZED", MFA_ERRORS.USER_NOT_FOUND);
  }

  const dontRememberMe = await ctx.getSignedCookie(
    ctx.context.authCookies.dontRememberToken.name,
    ctx.context.secret,
  );

  return { cookie, token, user, dontRememberMe: Boolean(dontRememberMe) };
}

async function userPasskeys(userId: string) {
  return db
    .select({
      id: passkeyTable.id,
      credentialID: passkeyTable.credentialID,
      publicKey: passkeyTable.publicKey,
      counter: passkeyTable.counter,
      transports: passkeyTable.transports,
    })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
}

async function assertPasswordAccount(
  ctx: GenericEndpointContext,
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;

  const [credential] = await db
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, session.user.id),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .limit(1);
  if (!credential) {
    throw APIError.from("BAD_REQUEST", MFA_ERRORS.PASSWORD_REQUIRED);
  }
}

export function passkeySecondFactor(): BetterAuthPlugin {
  return {
    id: "passkey-second-factor",
    endpoints: {
      mfaMethods: createAuthEndpoint(
        "/mfa/methods",
        { method: "GET" },
        async (ctx) => {
          const pending = await readPendingMfa(ctx);
          const state = await getMfaState(pending.user.id);
          return ctx.json(
            {
              methods: state.methods,
              totpRegistered: state.totpRegistered,
              passkeyCount: state.passkeyCount,
              backupCodesAvailable: await hasBackupCodes(pending.user.id),
            },
            { status: 200 },
          );
        },
      ),

      mfaPasskeyOptions: createAuthEndpoint(
        "/mfa/passkey/options",
        { method: "GET" },
        async (ctx) => {
          const pending = await readPendingMfa(ctx);
          const credentials = await userPasskeys(pending.user.id);
          if (credentials.length === 0) {
            throw APIError.from("BAD_REQUEST", MFA_ERRORS.PASSKEY_NOT_ENROLLED);
          }

          const options = await generateAuthenticationOptions({
            rpID: rpID(ctx),
            userVerification: "preferred",
            allowCredentials: credentials.map((credential) => ({
              id: credential.credentialID,
              transports: parseTransports(credential.transports),
            })),
          });

          const challengeToken = generateRandomString(32);
          const challengeCookie = ctx.context.createAuthCookie(
            CHALLENGE_COOKIE,
            { maxAge: CHALLENGE_MAX_AGE_SECONDS },
          );
          await ctx.setSignedCookie(
            challengeCookie.name,
            challengeToken,
            ctx.context.secret,
            {
              ...challengeCookie.attributes,
              maxAge: CHALLENGE_MAX_AGE_SECONDS,
            },
          );
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: challengeToken,
            value: JSON.stringify({
              type: "mfa-passkey",
              expectedChallenge: options.challenge,
              userId: pending.user.id,
              twoFactorToken: pending.token,
            }),
            expiresAt: new Date(Date.now() + CHALLENGE_MAX_AGE_SECONDS * 1000),
          });

          return ctx.json(options, { status: 200 });
        },
      ),

      mfaPasskeyVerify: createAuthEndpoint(
        // The suffix is deliberate: BetterAuth's lastLoginMethod plugin
        // recognises `/passkey/verify-authentication` and records `passkey`.
        "/mfa/passkey/verify-authentication",
        {
          method: "POST",
          body: z.object({
            response: z.custom<AuthenticationResponseJSON>(
              (value) => typeof value === "object" && value !== null,
            ),
            // Carries the signed authorize request so BetterAuth can resume it
            // after the session cookie is set (prompt/login, max_age).
            oauth_query: z.string().optional(),
          }),
        },
        async (ctx) => {
          const pending = await readPendingMfa(ctx);
          const origin = requestOrigin(ctx);
          if (!origin) {
            throw APIError.from("BAD_REQUEST", MFA_ERRORS.ORIGIN_MISSING);
          }

          const release = await acquireUserLock(pending.user.id);
          try {
            const challengeCookie =
              ctx.context.createAuthCookie(CHALLENGE_COOKIE);
            const challengeToken = await ctx.getSignedCookie(
              challengeCookie.name,
              ctx.context.secret,
            );
            if (!challengeToken) {
              throw APIError.from(
                "BAD_REQUEST",
                MFA_ERRORS.CHALLENGE_NOT_FOUND,
              );
            }

            const challengeVerification =
              await ctx.context.internalAdapter.consumeVerificationValue(
                challengeToken,
              );
            if (!challengeVerification) {
              throw APIError.from(
                "BAD_REQUEST",
                MFA_ERRORS.CHALLENGE_NOT_FOUND,
              );
            }

            let challenge: {
              type?: unknown;
              expectedChallenge?: unknown;
              userId?: unknown;
              twoFactorToken?: unknown;
            };
            try {
              challenge = JSON.parse(challengeVerification.value) as {
                type?: unknown;
                expectedChallenge?: unknown;
                userId?: unknown;
                twoFactorToken?: unknown;
              };
            } catch {
              throw APIError.from("BAD_REQUEST", MFA_ERRORS.CHALLENGE_INVALID);
            }

            if (
              challenge.type !== "mfa-passkey" ||
              typeof challenge.expectedChallenge !== "string" ||
              challenge.userId !== pending.user.id ||
              challenge.twoFactorToken !== pending.token
            ) {
              throw APIError.from("BAD_REQUEST", MFA_ERRORS.CHALLENGE_INVALID);
            }

            const response = ctx.body.response;
            if (typeof response.id !== "string" || !response.id) {
              throw APIError.from("BAD_REQUEST", MFA_ERRORS.CHALLENGE_INVALID);
            }

            const [credential] = await db
              .select({
                id: passkeyTable.id,
                publicKey: passkeyTable.publicKey,
                counter: passkeyTable.counter,
                transports: passkeyTable.transports,
              })
              .from(passkeyTable)
              .where(
                and(
                  eq(passkeyTable.userId, pending.user.id),
                  eq(passkeyTable.credentialID, response.id),
                ),
              )
              .limit(1);

            if (!credential) {
              throw APIError.from(
                "UNAUTHORIZED",
                MFA_ERRORS.AUTHENTICATION_FAILED,
              );
            }

            let verification;
            try {
              verification = await verifyAuthenticationResponse({
                response,
                expectedChallenge: challenge.expectedChallenge,
                expectedOrigin: pinnedOrigin(ctx, origin),
                expectedRPID: rpID(ctx),
                credential: {
                  id: response.id,
                  publicKey: Buffer.from(credential.publicKey, "base64"),
                  counter: credential.counter,
                  transports: parseTransports(credential.transports),
                },
                requireUserVerification: false,
              });
            } catch (error) {
              ctx.context.logger.warn(
                "Passkey second-factor verification failed",
                error instanceof Error ? error.message : "unknown error",
              );
              throw APIError.from(
                "UNAUTHORIZED",
                MFA_ERRORS.AUTHENTICATION_FAILED,
              );
            }

            if (!verification.verified) {
              throw APIError.from(
                "UNAUTHORIZED",
                MFA_ERRORS.AUTHENTICATION_FAILED,
              );
            }

            await db
              .update(passkeyTable)
              .set({ counter: verification.authenticationInfo.newCounter })
              .where(eq(passkeyTable.id, credential.id));

            const consumed =
              await ctx.context.internalAdapter.consumeVerificationValue(
                pending.token,
              );
            if (!consumed || consumed.value !== pending.user.id) {
              expireCookie(ctx, pending.cookie);
              throw APIError.from("UNAUTHORIZED", MFA_ERRORS.PENDING_NOT_FOUND);
            }

            const session = await ctx.context.internalAdapter.createSession(
              pending.user.id,
              pending.dontRememberMe,
            );
            if (!session) {
              throw APIError.from(
                "INTERNAL_SERVER_ERROR",
                MFA_ERRORS.SESSION_FAILED,
              );
            }

            await setSessionCookie(ctx, {
              session,
              user: pending.user,
            });
            expireCookie(ctx, pending.cookie);
            expireCookie(ctx, challengeCookie);

            return ctx.json(
              {
                token: session.token,
                user: parseUserOutput(ctx.context.options, pending.user),
              },
              { status: 200 },
            );
          } finally {
            release();
          }
        },
      ),
    },
    hooks: {
      before: [
        {
          // A passkey is a second factor here, so it needs a first factor.
          // Recheck at verification too: the credential can be unlinked after
          // the options challenge was issued.
          matcher: (ctx) =>
            ctx.path === "/passkey/generate-register-options" ||
            ctx.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            await assertPasswordAccount(ctx);
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const passkeyId = (ctx.body as { id?: unknown } | undefined)?.id;
            if (typeof passkeyId !== "string") return;

            const [target] = await db
              .select({ userId: passkeyTable.userId })
              .from(passkeyTable)
              .where(eq(passkeyTable.id, passkeyId))
              .limit(1);
            if (!target) return;
            const session = await getSessionFromCtx(ctx);
            if (!session || session.user.id !== target.userId) return;

            const reason = await checkMfaMethodRemoval(
              target.userId,
              "passkey",
            );
            if (reason === "MFA_REQUIRED") {
              throw APIError.from(
                "BAD_REQUEST",
                MFA_ERRORS.LAST_FACTOR_REQUIRED,
              );
            }
            if (reason === "LAST_AUTHENTICATION_METHOD") {
              throw APIError.from(
                "BAD_REQUEST",
                MFA_ERRORS.LAST_AUTHENTICATION_METHOD,
              );
            }
            await holdUserLock(ctx, target.userId);
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;

            // A pending TOTP setup (verified = false) is not an active method;
            // allow the user to clean it up even when MFA is required.
            const state = await getMfaState(session.user.id);
            if (!state.totpRegistered) return;

            const reason = await checkMfaMethodRemoval(session.user.id, "totp");
            if (reason === "MFA_REQUIRED") {
              throw APIError.from(
                "BAD_REQUEST",
                MFA_ERRORS.LAST_FACTOR_REQUIRED,
              );
            }
            await holdUserLock(ctx, session.user.id);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === "/passkey/verify-registration" ||
            ctx.path === "/passkey/delete-passkey" ||
            ctx.path === "/two-factor/enable" ||
            ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            const userId =
              ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
            if (userId) await reconcileMfaFlag(userId);
            if (
              userId &&
              (ctx.path === "/passkey/delete-passkey" ||
                ctx.path === "/two-factor/disable")
            ) {
              releaseUserLock(ctx);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
