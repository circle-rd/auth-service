import type { FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { config } from "./config.js";
import type { ApiError } from "./errors.js";
import { ERR } from "./errors.js";
import { verifyBearerAccessToken } from "./services/oauth-tokens.js";
import {
  assertAppAdmin,
  assertAppPermission,
  type AppDelegationPermission,
} from "./services/resources/authority.js";
import { ADMIN_ROLES, hasAnyRole } from "./services/roles.js";

/**
 * Shared Fastify authentication guards. Every admin route plugin attaches
 * `requireAdmin` at plugin level (`fastify.addHook("preHandler", requireAdmin)`)
 * and data/user routes use the session helpers below.
 */

/** The authenticated BetterAuth session, or null. */
export async function getRequestSession(req: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

/** The authenticated user's id, or null. Used to attribute audit entries. */
export async function getActorUserId(
  req: FastifyRequest,
): Promise<string | null> {
  const session = await getRequestSession(req);
  return session?.user.id ?? null;
}

async function sendAuthError(
  reply: FastifyReply,
  error: ApiError,
): Promise<string> {
  await reply.status(error.statusCode).send(error.toJSON());
  return "";
}

/**
 * Reject the request unless the caller holds one of the allowed roles. Sends
 * the error response itself; callers should stop when the reply has been sent.
 */
export function requireAnyRole(allowed: readonly string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await getRequestSession(req);
    if (!session) {
      await reply.status(401).send(ERR.AUTH_001().toJSON());
      return;
    }
    const role = (session.user as Record<string, unknown>).role as
      string | undefined;
    if (!hasAnyRole(role, allowed)) {
      await reply
        .status(403)
        .send(ERR.AUTH_011("Insufficient permissions").toJSON());
    }
  };
}

/** Reject the request unless the caller is an admin or superadmin. */
export const requireAdmin = requireAnyRole(ADMIN_ROLES);

/**
 * Require an authenticated session that may administer the given application.
 *
 * The application's built-in `admin` role is the original owner; explicit
 * `app_delegation` rows add one least-privilege permission at a time. Unknown,
 * foreign and unauthorised applications share the same 404 response.
 * Returns "" after sending 401/404, so callers can `if (!userId) return;`.
 */
export async function requireAppDelegation(
  req: FastifyRequest,
  reply: FastifyReply,
  applicationId: string,
  permission: AppDelegationPermission,
): Promise<string> {
  const session = await getRequestSession(req);
  if (!session) {
    return sendAuthError(reply, ERR.AUTH_001());
  }
  try {
    await assertAppPermission(session.user.id, applicationId, permission);
  } catch (error) {
    if (error instanceof Error && "toJSON" in error) {
      const apiError = error as ApiError;
      return sendAuthError(reply, apiError);
    }
    throw error;
  }
  return session.user.id;
}

/**
 * Require an authenticated application admin (or platform admin). Unknown,
 * foreign and unauthorised applications share the same 404 response.
 */
export async function requireResourceAppAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  applicationId: string,
): Promise<string> {
  const session = await getRequestSession(req);
  if (!session) {
    return sendAuthError(reply, ERR.AUTH_001());
  }
  try {
    await assertAppAdmin(session.user.id, applicationId);
  } catch (error) {
    if (error instanceof Error && "toJSON" in error) {
      const apiError = error as ApiError;
      return sendAuthError(reply, apiError);
    }
    throw error;
  }
  return session.user.id;
}

/**
 * Require any authenticated user and return their id. Returns "" after sending
 * a 401, so callers can `if (!userId) return;`.
 */
export async function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const session = await getRequestSession(req);
  if (!session) {
    return sendAuthError(reply, ERR.AUTH_001());
  }
  return session.user.id;
}

/** The user behind a request and the OAuth client it came through. */
export interface UserCaller {
  userId: string;
  // Null for the auth-service UI session, the client id for a bearer token.
  clientId: string | null;
}

/**
 * Accept either the caller's BetterAuth session or a user-bound JWT bearer
 * token minted for this API (`aud` must include the issuer URL). A bearer
 * token must carry at least one of the accepted scopes. Sends the error
 * response and returns null when the caller is refused.
 */
export async function requireUserOrBearerCaller(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string | readonly string[],
): Promise<UserCaller | null> {
  const accepted = typeof scope === "string" ? [scope] : scope;
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const verified = await verifyBearerAccessToken(authorization.slice(7));
    const refusal = !verified
      ? ERR.AUTH_001("Invalid or expired access token")
      : verified.userId === null
        ? ERR.AUTH_011("A user-bound access token is required")
        : !verified.audiences.includes(config.betterAuth.url)
          ? ERR.AUTH_011("Access token audience does not include this API")
          : !verified.scopes.some((granted) => accepted.includes(granted))
            ? ERR.AUTH_011(`Missing required scope: ${accepted.join(" or ")}`)
            : null;
    if (refusal || !verified?.userId) {
      await sendAuthError(reply, refusal ?? ERR.AUTH_001());
      return null;
    }
    return { userId: verified.userId, clientId: verified.clientId };
  }
  const userId = await requireSession(req, reply);
  return userId ? { userId, clientId: null } : null;
}

/**
 * Same admission as `requireUserOrBearerCaller`, for routes that only need the
 * user. Returns "" after sending the error, so callers can
 * `if (!userId) return;`.
 */
export async function requireUserOrBearer(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string | readonly string[],
): Promise<string> {
  const caller = await requireUserOrBearerCaller(req, reply, scope);
  return caller?.userId ?? "";
}

/** Require a session and return both user id and session id, or null. */
export async function requireFullSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; sessionId: string } | null> {
  const session = await getRequestSession(req);
  if (!session) {
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    return null;
  }
  return { userId: session.user.id, sessionId: session.session.id };
}

/**
 * Platform role of the authenticated caller. Only call after a guard has
 * confirmed a session; unknown roles are returned as-is rather than assumed.
 */
export async function getCallerRole(req: FastifyRequest): Promise<string> {
  const session = await getRequestSession(req);
  return (
    ((session?.user as Record<string, unknown> | undefined)?.role as
      string | undefined) ?? ""
  );
}
