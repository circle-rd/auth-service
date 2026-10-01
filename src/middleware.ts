import type { FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { ERR } from "./errors.js";

/**
 * Shared Fastify authentication guards. Every admin route plugin attaches
 * `requireAdmin` at plugin level (`fastify.addHook("preHandler", requireAdmin)`)
 * and data/user routes use the session helpers below.
 */

/** The authenticated BetterAuth session, or null. */
export async function getRequestSession(req: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
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
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    return "";
  }
  return session.user.id;
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
