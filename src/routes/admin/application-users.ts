import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import {
  userApplications,
  userAppRoles,
  loginHistory,
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { applicationUserAccessRoutes } from "./application-user-access.js";

export async function applicationUserRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ── App ↔ User access management ─────────────────────────────────────────────

  // GET /api/admin/applications/:id/users — list all users associated with this app.
  // Augments each row with `lastLoginAt` scoped to this application (computed
  // from `login_history`). A single grouped sub-select keeps this to one round
  // trip even when the membership list is large.
  fastify.get<{
    Params: { id: string };
    Querystring: { page?: string; limit?: string; search?: string };
  }>("/:id/users", async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20),
    );
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim().slice(0, 200) || undefined;
    const searchFilter = search
      ? or(
          ilike(userTable.name, `%${search}%`),
          ilike(userTable.email, `%${search}%`),
        )
      : undefined;
    const where = and(
      eq(userApplications.applicationId, req.params.id),
      searchFilter,
    );

    const [{ total }] = await db
      .select({ total: countDistinct(userApplications.userId) })
      .from(userApplications)
      .leftJoin(userTable, eq(userApplications.userId, userTable.id))
      .where(where);

    // A user may hold several roles (user_app_roles PK is user+app+role), so the
    // join would return one row per role. DISTINCT ON keeps exactly one row per
    // user, otherwise the UI shows duplicate rows and deleting one "removes both".
    const rows = await db
      .selectDistinctOn([userApplications.userId], {
        userId: userApplications.userId,
        isActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
        createdAt: userApplications.createdAt,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        roleId: userAppRoles.roleId,
      })
      .from(userApplications)
      .leftJoin(userTable, eq(userApplications.userId, userTable.id))
      .leftJoin(
        userAppRoles,
        and(
          eq(userAppRoles.userId, userApplications.userId),
          eq(userAppRoles.applicationId, userApplications.applicationId),
        ),
      )
      .where(where)
      .orderBy(userApplications.userId, userAppRoles.createdAt)
      .limit(limit)
      .offset(offset);

    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    const lastLoginByUser = new Map<
      string,
      { lastLoginAt: Date; lastIp: string | null; lastUserAgent: string | null }
    >();
    if (userIds.length > 0) {
      const lastLogins = await db
        .selectDistinctOn([loginHistory.userId], {
          userId: loginHistory.userId,
          lastLoginAt: loginHistory.loggedAt,
          lastIp: loginHistory.ipAddress,
          lastUserAgent: loginHistory.userAgent,
        })
        .from(loginHistory)
        .where(
          and(
            eq(loginHistory.applicationId, req.params.id),
            inArray(loginHistory.userId, userIds),
          ),
        )
        .orderBy(loginHistory.userId, desc(loginHistory.loggedAt));
      for (const r of lastLogins) {
        lastLoginByUser.set(r.userId, {
          lastLoginAt: r.lastLoginAt,
          lastIp: r.lastIp,
          lastUserAgent: r.lastUserAgent,
        });
      }
    }

    const enriched = rows.map((r) => {
      const last = lastLoginByUser.get(r.userId);
      return {
        ...r,
        lastLoginAt: last?.lastLoginAt ?? null,
        lastIp: last?.lastIp ?? null,
        lastUserAgent: last?.lastUserAgent ?? null,
      };
    });

    await reply.send({ users: enriched, total, page, limit });
  });

  // GET /api/admin/applications/:id/users/:userId/history — paginated login
  // history for a single user inside a single application. Powers the history
  // modal opened from the row-action icon in the app users tab.
  fastify.get<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId/history",
    async (req, reply) => {
      const query = req.query as Record<string, string>;
      const page = Math.max(1, parseInt(query.page ?? "1", 10));
      const limit = Math.min(
        100,
        Math.max(1, parseInt(query.limit ?? "20", 10)),
      );
      const offset = (page - 1) * limit;

      const where = and(
        eq(loginHistory.applicationId, req.params.id),
        eq(loginHistory.userId, req.params.userId),
      );

      const [{ total }] = await db
        .select({ total: count() })
        .from(loginHistory)
        .where(where);

      const entries = await db
        .select({
          id: loginHistory.id,
          loggedAt: loginHistory.loggedAt,
          ipAddress: loginHistory.ipAddress,
          userAgent: loginHistory.userAgent,
          sessionId: loginHistory.sessionId,
        })
        .from(loginHistory)
        .where(where)
        .orderBy(desc(loginHistory.loggedAt))
        .limit(limit)
        .offset(offset);

      await reply.send({ entries, total, page, limit });
    },
  );
  await fastify.register(applicationUserAccessRoutes);
}
