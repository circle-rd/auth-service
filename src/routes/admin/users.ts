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
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { and, count, eq } from "drizzle-orm";
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

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(["user", "admin", "superadmin"]).optional(),
  isMfaRequired: z.boolean().optional(),
});

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["user", "admin", "superadmin"]).default("user"),
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

    await reply.send({
      users: users.users,
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

    // Get user's app access with application details
    const appAccess = await db
      .select({
        id: applications.id,
        name: applications.name,
        slug: applications.slug,
        icon: applications.icon,
        isActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
      })
      .from(userApplications)
      .innerJoin(
        applications,
        eq(userApplications.applicationId, applications.id),
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

    const appsWithRoles = appAccess.map((app) => ({
      ...app,
      roles: rolesByApp.get(app.id) ?? [],
    }));

    await reply.send({ user, applications: appsWithRoles });
  });

  // PATCH /api/admin/users/:id
  fastify.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.USR_003("Invalid user data", parsed.error.flatten());

    const { role, isMfaRequired, name } = parsed.data;

    if (role) {
      // Cast needed — BetterAuth's admin type only knows "user"|"admin" by default
      await auth.api.setRole({
        headers: fromNodeHeaders(req.headers),
        body: { userId: req.params.id, role: role as "user" | "admin" },
      });
    }

    if (name !== undefined || isMfaRequired !== undefined) {
      // Direct DB update: updateUser is for self-update only
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
    const target = await auth.api
      .getUser?.({
        headers: fromNodeHeaders(req.headers),
        query: { id: req.params.id },
      })
      .catch(() => null);
    if (!target) throw ERR.USR_001();

    // Prevent admins from deleting themselves
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session?.user.id === req.params.id) {
      throw ERR.USR_003("You cannot delete your own account");
    }

    // Prevent deleting the last superadmin
    if ((target as unknown as Record<string, unknown>).role === "superadmin") {
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
