import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  appRoles,
  appPermissions,
  appRolePermissions,
  userAppRoles,
} from "../../db/schema.js";
import { and, eq, ne, count } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";

const PERMISSION_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

// ── Middleware ────────────────────────────────────────────────────────────────
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

// ── Schemas ───────────────────────────────────────────────────────────────────
const createRoleSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(250).optional(),
  isDefault: z.boolean().default(false),
});

const createPermissionSchema = z.object({
  resource: z.string().min(1).max(128),
  action: z.enum(["read", "write"]).default("read"),
});

// ── Routes ────────────────────────────────────────────────────────────────────
export async function rolesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // ── App existence helper ───────────────────────────────────────────────────
  async function ensureApp(appId: string): Promise<void> {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, appId))
      .limit(1);
    if (!app) throw ERR.APP_002();
  }

  // GET /api/admin/applications/:appId/roles
  fastify.get<{ Params: { appId: string } }>(
    "/applications/:appId/roles",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      const roles = await db
        .select()
        .from(appRoles)
        .where(eq(appRoles.applicationId, req.params.appId));

      // Fetch all role-permission assignments for this application in one query
      const assignments = await db
        .select({
          roleId: appRolePermissions.roleId,
          permissionId: appRolePermissions.permissionId,
        })
        .from(appRolePermissions)
        .innerJoin(appRoles, eq(appRolePermissions.roleId, appRoles.id))
        .where(eq(appRoles.applicationId, req.params.appId));

      const permMap = new Map<string, string[]>();
      for (const { roleId, permissionId } of assignments) {
        const existing = permMap.get(roleId);
        if (existing) existing.push(permissionId);
        else permMap.set(roleId, [permissionId]);
      }

      const rolesWithPermissions = roles.map((r) => ({
        ...r,
        permissionIds: permMap.get(r.id) ?? [],
      }));

      await reply.send({ roles: rolesWithPermissions });
    },
  );

  // POST /api/admin/applications/:appId/roles
  fastify.post<{ Params: { appId: string } }>(
    "/applications/:appId/roles",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      const parsed = createRoleSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid role", parsed.error.flatten());

      const [existing] = await db
        .select({ id: appRoles.id })
        .from(appRoles)
        .where(
          and(
            eq(appRoles.applicationId, req.params.appId),
            eq(appRoles.name, parsed.data.name),
          ),
        )
        .limit(1);
      if (existing) throw ERR.PERM_004();

      const [role] = await db.transaction(async (tx) => {
        // Ensure at most one default role per app
        if (parsed.data.isDefault) {
          await tx
            .update(appRoles)
            .set({ isDefault: false })
            .where(eq(appRoles.applicationId, req.params.appId));
        }
        return tx
          .insert(appRoles)
          .values({
            applicationId: req.params.appId,
            name: parsed.data.name,
            description: parsed.data.description,
            isDefault: parsed.data.isDefault,
          })
          .returning();
      });

      await reply.status(201).send({ role });
    },
  );

  // PATCH /api/admin/applications/:appId/roles/:roleId
  fastify.patch<{ Params: { appId: string; roleId: string } }>(
    "/applications/:appId/roles/:roleId",
    async (req, reply) => {
      const parsed = createRoleSchema.partial().safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid role data", parsed.error.flatten());

      const [role] = await db.transaction(async (tx) => {
        // Ensure at most one default role per app
        if (parsed.data.isDefault) {
          await tx
            .update(appRoles)
            .set({ isDefault: false })
            .where(
              and(
                eq(appRoles.applicationId, req.params.appId),
                ne(appRoles.id, req.params.roleId),
              ),
            );
        }
        return tx
          .update(appRoles)
          .set(parsed.data)
          .where(
            and(
              eq(appRoles.id, req.params.roleId),
              eq(appRoles.applicationId, req.params.appId),
            ),
          )
          .returning();
      });
      if (!role) throw ERR.PERM_002();

      await reply.send({ role });
    },
  );

  // DELETE /api/admin/applications/:appId/roles/:roleId
  fastify.delete<{ Params: { appId: string; roleId: string } }>(
    "/applications/:appId/roles/:roleId",
    async (req, reply) => {
      const [assigned] = await db
        .select({ cnt: count() })
        .from(userAppRoles)
        .where(eq(userAppRoles.roleId, req.params.roleId));
      if (assigned && Number(assigned.cnt) > 0) throw ERR.PERM_006();

      const [deleted] = await db
        .delete(appRoles)
        .where(
          and(
            eq(appRoles.id, req.params.roleId),
            eq(appRoles.applicationId, req.params.appId),
          ),
        )
        .returning({ id: appRoles.id });
      if (!deleted) throw ERR.PERM_002();

      await reply.status(204).send();
    },
  );

  // ── Permissions ────────────────────────────────────────────────────────────

  // GET /api/admin/applications/:appId/permissions
  fastify.get<{ Params: { appId: string } }>(
    "/applications/:appId/permissions",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      const perms = await db
        .select()
        .from(appPermissions)
        .where(eq(appPermissions.applicationId, req.params.appId));
      await reply.send({ permissions: perms });
    },
  );

  // POST /api/admin/applications/:appId/permissions
  fastify.post<{ Params: { appId: string } }>(
    "/applications/:appId/permissions",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      const parsed = createPermissionSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid permission", parsed.error.flatten());

      if (!PERMISSION_RE.test(parsed.data.resource)) throw ERR.PERM_001();

      const [existing] = await db
        .select({ id: appPermissions.id })
        .from(appPermissions)
        .where(
          and(
            eq(appPermissions.applicationId, req.params.appId),
            eq(appPermissions.resource, parsed.data.resource),
            eq(appPermissions.action, parsed.data.action),
          ),
        )
        .limit(1);
      if (existing) throw ERR.PERM_005();

      const [perm] = await db
        .insert(appPermissions)
        .values({
          applicationId: req.params.appId,
          resource: parsed.data.resource,
          action: parsed.data.action,
        })
        .returning();

      await reply.status(201).send({ permission: perm });
    },
  );

  // DELETE /api/admin/applications/:appId/permissions/:permId
  fastify.delete<{ Params: { appId: string; permId: string } }>(
    "/applications/:appId/permissions/:permId",
    async (req, reply) => {
      const [deleted] = await db
        .delete(appPermissions)
        .where(
          and(
            eq(appPermissions.id, req.params.permId),
            eq(appPermissions.applicationId, req.params.appId),
          ),
        )
        .returning({ id: appPermissions.id });
      if (!deleted) throw ERR.PERM_003();

      await reply.status(204).send();
    },
  );

  // ── Role ↔ Permission assignment ───────────────────────────────────────────

  // POST /api/admin/applications/:appId/roles/:roleId/permissions
  fastify.post<{ Params: { appId: string; roleId: string } }>(
    "/applications/:appId/roles/:roleId/permissions",
    async (req, reply) => {
      const body = z
        .object({ permissionId: z.string().uuid() })
        .safeParse(req.body);
      if (!body.success) throw ERR.PERM_003();

      await db
        .insert(appRolePermissions)
        .values({
          roleId: req.params.roleId,
          permissionId: body.data.permissionId,
        })
        .onConflictDoNothing();

      await reply.status(201).send({ ok: true });
    },
  );

  // DELETE /api/admin/applications/:appId/roles/:roleId/permissions/:permId
  fastify.delete<{ Params: { appId: string; roleId: string; permId: string } }>(
    "/applications/:appId/roles/:roleId/permissions/:permId",
    async (req, reply) => {
      await db
        .delete(appRolePermissions)
        .where(
          and(
            eq(appRolePermissions.roleId, req.params.roleId),
            eq(appRolePermissions.permissionId, req.params.permId),
          ),
        );
      await reply.status(204).send();
    },
  );
}
