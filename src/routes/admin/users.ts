import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  userApplications,
  applications,
  userAppRoles,
  appRoles,
  userSubscriptions,
  consumptionEntries,
  consumptionAggregates,
  loginHistory,
  subscriptionPlans,
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
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

/** Returns the calling user's platform role. Called after requireAdmin so session is guaranteed. */
async function getCallerRole(req: FastifyRequest): Promise<string> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return ((session!.user as Record<string, unknown>).role as string | undefined) ?? "admin";
}

// superadmin cannot be assigned via API — it is provisioned only at bootstrap via env vars.
const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(["user", "admin"]).optional(),
  isMfaRequired: z.boolean().optional(),
});

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  // Only superadmin can create admin users. "superadmin" is never assignable via API.
  role: z.enum(["user", "admin"]).default("user"),
});

export async function usersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // ── Global User Management ─────────────────────────────────────────────────

  // GET /api/admin/users
  fastify.get("/", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10)));
    const search = query.search?.trim();
    const offset = (page - 1) * limit;

    const users = await auth.api.listUsers({
      headers: fromNodeHeaders(req.headers),
      query: {
        limit: String(limit),
        offset: String(offset),
        ...(search ? { searchValue: search, searchField: "email" } : {}),
      },
    });

    // Enrich each user with the list of applications they have access to and
    // a fallback lastLoginAt (the user.lastLoginAt column is denormalised in
    // recordLogin()). One grouped query per dimension keeps this O(1) round
    // trips regardless of the page size.
    const userIds = users.users.map((u) => u.id);
    const appsByUser = new Map<
      string,
      { id: string; name: string; slug: string; icon: string | null }[]
    >();
    const lastLoginByUser = new Map<string, Date>();
    if (userIds.length > 0) {
      const accessRows = await db
        .select({
          userId: userApplications.userId,
          id: applications.id,
          name: applications.name,
          slug: applications.slug,
          icon: applications.icon,
        })
        .from(userApplications)
        .innerJoin(
          applications,
          eq(userApplications.applicationId, applications.id),
        )
        .where(
          and(
            inArray(userApplications.userId, userIds),
            eq(userApplications.isActive, true),
          ),
        );
      for (const row of accessRows) {
        const list = appsByUser.get(row.userId) ?? [];
        list.push({
          id: row.id,
          name: row.name,
          slug: row.slug,
          icon: row.icon,
        });
        appsByUser.set(row.userId, list);
      }

      const lastLogins = await db
        .select({
          userId: loginHistory.userId,
          lastLoginAt: max(loginHistory.loggedAt),
        })
        .from(loginHistory)
        .where(inArray(loginHistory.userId, userIds))
        .groupBy(loginHistory.userId);
      for (const r of lastLogins) {
        if (r.lastLoginAt) lastLoginByUser.set(r.userId, r.lastLoginAt);
      }
    }

    const enriched = users.users.map((u) => {
      const denormalised = (u as unknown as Record<string, unknown>)
        .lastLoginAt as Date | string | null | undefined;
      const fromHistory = lastLoginByUser.get(u.id) ?? null;
      const denormalisedDate =
        denormalised instanceof Date
          ? denormalised
          : typeof denormalised === "string"
            ? new Date(denormalised)
            : null;
      return {
        ...u,
        applications: appsByUser.get(u.id) ?? [],
        lastLoginAt: denormalisedDate ?? fromHistory,
      };
    });

    await reply.send({
      users: enriched,
      total: users.total,
      page,
      limit,
    });
  });

  // POST /api/admin/users — create a user manually
  fastify.post("/", async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.USR_003("Invalid user data", parsed.error.flatten());

    const { name, email, password, role } = parsed.data;

    // Only superadmin can create admin-role users
    if (role === "admin") {
      const callerRole = await getCallerRole(req);
      if (callerRole !== "superadmin") {
        throw ERR.AUTH_001("Only superadmins can create admin users");
      }
    }

    try {
      const result = await auth.api.createUser({
        headers: fromNodeHeaders(req.headers),
        body: { name, email, password, role: role as "user" | "admin" },
      });
      await reply.status(201).send({ user: result.user });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create user";
      throw ERR.USR_003(msg);
    }
  });

  // GET /api/admin/users/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const user = await auth.api
      .getUser?.({
        headers: fromNodeHeaders(req.headers),
        query: { id: req.params.id },
      })
      .catch(() => null);
    if (!user) throw ERR.USR_001();

    // Get user's app access with application details. Left-join the plan
    // table so the UI can display the human-readable plan name instead of
    // the raw UUID stored on user_applications.
    const appAccess = await db
      .select({
        id: applications.id,
        name: applications.name,
        slug: applications.slug,
        icon: applications.icon,
        isActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
        subscriptionPlanName: subscriptionPlans.name,
      })
      .from(userApplications)
      .innerJoin(
        applications,
        eq(userApplications.applicationId, applications.id),
      )
      .leftJoin(
        subscriptionPlans,
        eq(userApplications.subscriptionPlanId, subscriptionPlans.id),
      )
      .where(eq(userApplications.userId, req.params.id));

    // Get per-app roles for this user
    const roleAccess = await db
      .select({
        applicationId: userAppRoles.applicationId,
        roleId: userAppRoles.roleId,
        roleName: appRoles.name,
      })
      .from(userAppRoles)
      .innerJoin(appRoles, eq(userAppRoles.roleId, appRoles.id))
      .where(eq(userAppRoles.userId, req.params.id));

    // Map roles by applicationId
    const rolesByApp = new Map<string, { id: string; name: string }[]>();
    for (const r of roleAccess) {
      const existing = rolesByApp.get(r.applicationId) ?? [];
      existing.push({ id: r.roleId, name: r.roleName });
      rolesByApp.set(r.applicationId, existing);
    }

    // Most recent login per application for this user. One round trip,
    // one row per applicationId — Postgres-only selectDistinctOn is fine
    // because the project pins on postgres.js.
    const lastLoginRows = await db
      .selectDistinctOn([loginHistory.applicationId], {
        applicationId: loginHistory.applicationId,
        lastLoginAt: loginHistory.loggedAt,
      })
      .from(loginHistory)
      .where(eq(loginHistory.userId, req.params.id))
      .orderBy(loginHistory.applicationId, desc(loginHistory.loggedAt));
    const lastLoginByApp = new Map<string, Date>();
    for (const r of lastLoginRows) {
      if (r.applicationId && r.lastLoginAt) {
        lastLoginByApp.set(r.applicationId, r.lastLoginAt);
      }
    }

    const appsWithRoles = appAccess.map((app) => ({
      ...app,
      roles: rolesByApp.get(app.id) ?? [],
      lastLoginAt: lastLoginByApp.get(app.id) ?? null,
    }));

    await reply.send({ user, applications: appsWithRoles });
  });

  // PATCH /api/admin/users/:id
  fastify.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.USR_003("Invalid user data", parsed.error.flatten());

    const { role, isMfaRequired, name } = parsed.data;

    // Fetch target to enforce hierarchy checks
    const [targetRow] = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, req.params.id))
      .limit(1);
    if (!targetRow) throw ERR.USR_001();

    const callerRole = await getCallerRole(req);
    const targetRole = targetRow.role ?? "user";

    // Admins cannot modify other admins or superadmins
    if (callerRole !== "superadmin" && (targetRole === "admin" || targetRole === "superadmin")) {
      throw ERR.AUTH_001("Insufficient permissions to modify this user");
    }
    // Only superadmin can promote someone to admin
    if (role === "admin" && callerRole !== "superadmin") {
      throw ERR.AUTH_001("Only superadmins can assign the admin role");
    }

    if (role) {
      // Direct DB update — set-role was removed from admin's BetterAuth permissions
      // to prevent native API abuse; all role changes go through this controlled path.
      await db
        .update(userTable)
        .set({ role })
        .where(eq(userTable.id, req.params.id));
    }

    if (name !== undefined || isMfaRequired !== undefined) {
      await db
        .update(userTable)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(isMfaRequired !== undefined ? { isMfaRequired } : {}),
        })
        .where(eq(userTable.id, req.params.id));
    }

    await reply.send({ ok: true });
  });

  // POST /api/admin/users/:id/disable
  fastify.post<{ Params: { id: string } }>(
    "/:id/disable",
    async (req, reply) => {
      const [targetRow] = await db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, req.params.id))
        .limit(1);
      if (!targetRow) throw ERR.USR_001();

      const callerRole = await getCallerRole(req);
      if (callerRole !== "superadmin" && (targetRow.role === "admin" || targetRow.role === "superadmin")) {
        throw ERR.AUTH_001("Insufficient permissions to disable this user");
      }

      await auth.api.banUser({
        headers: fromNodeHeaders(req.headers),
        body: { userId: req.params.id },
      });
      await reply.send({ ok: true });
    },
  );

  // POST /api/admin/users/:id/enable
  fastify.post<{ Params: { id: string } }>(
    "/:id/enable",
    async (req, reply) => {
      const [targetRow] = await db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, req.params.id))
        .limit(1);
      if (!targetRow) throw ERR.USR_001();

      const callerRole = await getCallerRole(req);
      if (callerRole !== "superadmin" && (targetRow.role === "admin" || targetRow.role === "superadmin")) {
        throw ERR.AUTH_001("Insufficient permissions to enable this user");
      }

      await auth.api.unbanUser({
        headers: fromNodeHeaders(req.headers),
        body: { userId: req.params.id },
      });
      await reply.send({ ok: true });
    },
  );

  // DELETE /api/admin/users/:id
  fastify.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    // Verify the target user exists
    const [targetRow] = await db
      .select({ id: userTable.id, role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, req.params.id))
      .limit(1);
    if (!targetRow) throw ERR.USR_001();

    const callerRole = await getCallerRole(req);

    // Admins cannot delete other admins or superadmins
    if (callerRole !== "superadmin" && (targetRow.role === "admin" || targetRow.role === "superadmin")) {
      throw ERR.AUTH_001("Insufficient permissions to delete this user");
    }

    // Prevent anyone from deleting themselves
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session?.user.id === req.params.id) {
      throw ERR.USR_003("You cannot delete your own account");
    }

    // Prevent deleting the last superadmin
    if (targetRow.role === "superadmin") {
      const [{ total }] = await db
        .select({ total: count() })
        .from(userTable)
        .where(eq(userTable.role, "superadmin"));
      if (Number(total) <= 1) {
        throw ERR.USR_002();
      }
    }

    // Delete the user — cascade constraints in auth-schema handle BetterAuth-owned records.
    // Our custom tables store userId as plain text without a FK, so we clean them manually.
    await db.transaction(async (tx) => {
      await tx.delete(userAppRoles).where(eq(userAppRoles.userId, req.params.id));
      await tx.delete(userSubscriptions).where(eq(userSubscriptions.userId, req.params.id));
      await tx.delete(consumptionAggregates).where(eq(consumptionAggregates.userId, req.params.id));
      await tx.delete(consumptionEntries).where(eq(consumptionEntries.userId, req.params.id));
      await tx.delete(userApplications).where(eq(userApplications.userId, req.params.id));
      await tx.delete(userTable).where(eq(userTable.id, req.params.id));
    });

    await reply.status(204).send();
  });

  // ── Application ↔ User Access (legacy stubs — moved to applicationRoutes) ──
  // These endpoints now live at /api/admin/applications/:appId/users[/:userId]
  // handled by src/routes/admin/applications.ts, registered with the correct prefix.
}
