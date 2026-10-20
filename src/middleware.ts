import type { FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { config } from "./config.js";
import type { ApiError } from "./errors.js";
import { ERR } from "./errors.js";
import { verifyBearerAccessToken } from "./services/oauth-tokens.js";

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
 * Reject the request unless the caller is an admin or superadmin. Sends the
 * error response itself; callers should stop when the reply has been sent.
 */
export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await getRequestSession(req);
  if (!session) {
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    return;
  }
  const role = (session.user as Record<string, unknown>).role as
    string | undefined;
  if (role !== "admin" && role !== "superadmin") {
    await reply
      .status(403)
      .send(ERR.AUTH_011("Insufficient permissions").toJSON());
    return;
  }
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

/**
 * Accept either the caller's BetterAuth session or a user-bound JWT bearer
 * token minted for this API (`aud` must include the issuer URL).
 */
export async function requireUserOrBearer(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string,
): Promise<string> {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const verified = await verifyBearerAccessToken(authorization.slice(7));
    if (!verified) {
      return sendAuthError(
        reply,
        ERR.AUTH_001("Invalid or expired access token"),
      );
    }
    if (verified.userId === null) {
      return sendAuthError(
        reply,
        ERR.AUTH_011("A user-bound access token is required"),
      );
    }
    if (!verified.audiences.includes(config.betterAuth.url)) {
      return sendAuthError(
        reply,
        ERR.AUTH_011("Access token audience does not include this API"),
      );
    }
    if (!verified.scopes.includes(scope)) {
      return sendAuthError(
        reply,
        ERR.AUTH_011(`Missing required scope: ${scope}`),
      );
    }
    return verified.userId;
  }
  return requireSession(req, reply);
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
