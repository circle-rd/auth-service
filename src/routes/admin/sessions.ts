import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { db } from "../../db/index.js";
import { session as sessionTable, user as userTable } from "../../db/auth-schema.js";
import { applications, loginHistory } from "../../db/schema.js";
import { and, count, desc, eq, gt, gte, ilike, inArray, or, type SQL } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";

async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) {
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    return;
  }
  const role = (session.user as Record<string, unknown>).role as
    | string
    | undefined;
  if (role !== "admin" && role !== "superadmin") {
    await reply
      .status(403)
      .send(ERR.AUTH_001("Insufficient permissions").toJSON());
    return;
  }
}

export async function sessionsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/sessions
  // Returns active (non-expired) sessions enriched with their user identity
  // and the list of applications the user logged into since the session was
  // created. SSO means one session can serve multiple apps, so the linkage is
  // many-to-many through login_history.
  fastify.get("/", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10)));
    const offset = (page - 1) * limit;
    const search = query.search?.trim();
    const now = new Date();

    // Search matches user name, email or session IP. Built as a single OR
    // expression so we can reuse it for both COUNT and SELECT below.
    const conditions: SQL[] = [gt(sessionTable.expiresAt, now)];
    if (search) {
      const pattern = `%${search}%`;
      const orExpr = or(
        ilike(userTable.name, pattern),
        ilike(userTable.email, pattern),
        ilike(sessionTable.ipAddress, pattern),
      );
      if (orExpr) conditions.push(orExpr);
    }
    const whereExpr = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(sessionTable)
      .leftJoin(userTable, eq(sessionTable.userId, userTable.id))
      .where(whereExpr);

    const list = await db
      .select({
        id: sessionTable.id,
        userId: sessionTable.userId,
        userAgent: sessionTable.userAgent,
        ipAddress: sessionTable.ipAddress,
        createdAt: sessionTable.createdAt,
        expiresAt: sessionTable.expiresAt,
        userName: userTable.name,
        userEmail: userTable.email,
        userImage: userTable.image,
      })
      .from(sessionTable)
      .leftJoin(userTable, eq(sessionTable.userId, userTable.id))
      .where(whereExpr)
      .orderBy(desc(sessionTable.createdAt))
      .limit(limit)
      .offset(offset);

    // Bulk-resolve the apps each user logged into since their oldest visible
    // session was created. Cheap distinct query on the (userId, loggedAt) index.
    const userIds = Array.from(new Set(list.map((s) => s.userId)));
    const oldestSessionStart = list.reduce<Date | null>((min, s) => {
      if (!min || s.createdAt < min) return s.createdAt;
      return min;
    }, null);
    const appsByUser = new Map<
      string,
      { id: string; name: string; slug: string; icon: string | null }[]
    >();
    if (userIds.length > 0 && oldestSessionStart) {
      const rows = await db
        .selectDistinct({
          userId: loginHistory.userId,
          id: applications.id,
          name: applications.name,
          slug: applications.slug,
          icon: applications.icon,
        })
        .from(loginHistory)
        .innerJoin(applications, eq(loginHistory.applicationId, applications.id))
        .where(
          and(
            inArray(loginHistory.userId, userIds),
            gte(loginHistory.loggedAt, oldestSessionStart),
          ),
        );
      for (const r of rows) {
        const arr = appsByUser.get(r.userId) ?? [];
        arr.push({ id: r.id, name: r.name, slug: r.slug, icon: r.icon });
        appsByUser.set(r.userId, arr);
      }
    }

    const sessions = list.map((s) => ({
      id: s.id,
      userId: s.userId,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      user: {
        id: s.userId,
        name: s.userName,
        email: s.userEmail,
        image: s.userImage,
      },
      applications: appsByUser.get(s.userId) ?? [],
    }));

    await reply.send({ total, sessions, page, limit });
  });
}
