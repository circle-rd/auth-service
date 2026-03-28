import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { generateId } from "better-auth";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  userApplications,
  userAppRoles,
  consumptionAggregates,
  subscriptionPlans,
  userSubscriptions,
} from "../../db/schema.js";
import { oauthClient } from "../../db/auth-schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { and, eq } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";
import { randomBytes, createHash } from "node:crypto";

/** Hash a plaintext client secret using SHA-256 base64url (matches BetterAuth's defaultHasher). */
function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest().toString("base64url");
}

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

const createAppSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
  skipConsent: z.boolean().default(false),
  allowedScopes: z.array(z.string()).default(["openid", "profile", "email"]),
  redirectUris: z.array(z.string().min(1)).default([]),
  url: z.string().url().optional().nullable(),
  icon: z.string().optional().nullable(),
});

const updateAppSchema = createAppSchema.partial().omit({ slug: true });

const grantUserAccessSchema = z.object({
  userId: z.string().min(1),
  roleId: z.string().uuid().optional(),
});

const updateUserAccessSchema = z.object({
  isActive: z.boolean().optional(),
  roleId: z.string().uuid().optional().nullable(),
  subscriptionPlanId: z.string().uuid().optional().nullable(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

export async function applicationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  /**
   * Assigns the application's default subscription plan to a user if:
   *  - the app has a plan marked as isDefault = true
   *  - the user does not already have an active subscription for that app
   * Also sets userApplications.subscriptionPlanId for convenience.
   */
  async function assignDefaultPlanIfNeeded(
    userId: string,
    applicationId: string,
  ): Promise<void> {
    const [defaultPlan] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(
        and(
          eq(subscriptionPlans.applicationId, applicationId),
          eq(subscriptionPlans.isDefault, true),
        ),
      )
      .limit(1);

    if (!defaultPlan) return;

    // Check if user already has a subscription (active or not)
    const [existing] = await db
      .select({ id: userSubscriptions.id })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          eq(userSubscriptions.applicationId, applicationId),
        ),
      )
      .limit(1);

    if (existing) return;

    await db.transaction(async (tx) => {
      await tx.insert(userSubscriptions).values({
        userId,
        applicationId,
        planId: defaultPlan.id,
        isActive: true,
      });
      await tx
        .update(userApplications)
        .set({ subscriptionPlanId: defaultPlan.id })
        .where(
          and(
            eq(userApplications.userId, userId),
            eq(userApplications.applicationId, applicationId),
          ),
        );
    });
  }

  // GET /api/admin/applications
  fastify.get("/", async (_req, reply) => {
    const rows = await db
      .select()
      .from(applications)
      .orderBy(applications.createdAt);
    await reply.send({ applications: rows });
  });

  // POST /api/admin/applications
  fastify.post("/", async (req, reply) => {
    const parsed = createAppSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ERR.APP_001("Invalid application data", parsed.error.flatten());
    }
    const data = parsed.data;

    // Check slug uniqueness (slug is used as the OAuth clientId)
    const [existing] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, data.slug))
      .limit(1);
    if (existing) throw ERR.APP_003();

    // Generate and hash the client secret
    const rawSecret = randomBytes(32).toString("hex");
    const hashedSecret = hashClientSecret(rawSecret);

    // Transactionally create the application row and the corresponding oauthClient row
    const [app] = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(applications)
        .values({
          name: data.name,
          slug: data.slug,
          description: data.description,
          isActive: data.isActive,
          skipConsent: data.skipConsent,
          allowedScopes: data.allowedScopes,
          redirectUris: data.redirectUris,
          url: data.url,
          icon: data.icon,
        })
        .returning();

      const app = rows[0]!;

      // Insert into BetterAuth's oauthClient table.
      // slug is used as clientId so external apps can reference it by name.
      // metadata.clientId is read by customIdTokenClaims to resolve claims.
      await tx.insert(oauthClient).values({
        id: generateId(),
        clientId: data.slug,
        clientSecret: hashedSecret,
        name: data.name,
        skipConsent: data.skipConsent,
        scopes: data.allowedScopes,
        redirectUris: data.redirectUris,
        metadata: { clientId: data.slug, applicationId: app.id },
      });

      return rows;
    });

    await reply.status(201).send({
      application: app,
      clientId: data.slug,
      // Secret shown once — not persisted in plaintext
      clientSecret: rawSecret,
    });
  });

  // GET /api/admin/applications/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!app) throw ERR.APP_002();
    await reply.send({ application: app });
  });

  // PATCH /api/admin/applications/:id
  fastify.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = updateAppSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid data", parsed.error.flatten());

    const [app] = await db
      .update(applications)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(applications.id, req.params.id))
      .returning();
    if (!app) throw ERR.APP_002();

    // Sync relevant fields to the BetterAuth oauthClient table
    const oauthUpdate: Partial<typeof oauthClient.$inferInsert> = {};
    if (parsed.data.name !== undefined) oauthUpdate.name = parsed.data.name;
    if (parsed.data.allowedScopes !== undefined)
      oauthUpdate.scopes = parsed.data.allowedScopes;
    if (parsed.data.skipConsent !== undefined)
      oauthUpdate.skipConsent = parsed.data.skipConsent;
    if (parsed.data.redirectUris !== undefined)
      oauthUpdate.redirectUris = parsed.data.redirectUris;

    if (Object.keys(oauthUpdate).length > 0) {
      await db
        .update(oauthClient)
        .set(oauthUpdate)
        .where(eq(oauthClient.clientId, app.slug));
    }

    await reply.send({ application: app });
  });

  // DELETE /api/admin/applications/:id
  // All related rows (roles, plans, user_applications, etc.) are cascade-deleted via FK constraints.
  fastify.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [deleted] = await db
      .delete(applications)
      .where(eq(applications.id, req.params.id))
      .returning({ id: applications.id, slug: applications.slug });
    if (!deleted) throw ERR.APP_002();

    // Remove the oauthClient row (cascades to tokens/consents in BetterAuth tables)
    await db.delete(oauthClient).where(eq(oauthClient.clientId, deleted.slug));

    await reply.status(204).send();
  });

  // POST /api/admin/applications/:id/rotate-secret
  fastify.post<{ Params: { id: string } }>(
    "/:id/rotate-secret",
    async (req, reply) => {
      const [app] = await db
        .select({ id: applications.id, slug: applications.slug })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      const newSecret = randomBytes(32).toString("hex");
      const hashedSecret = hashClientSecret(newSecret);

      await db
        .update(oauthClient)
        .set({ clientSecret: hashedSecret })
        .where(eq(oauthClient.clientId, app.slug));

      await reply.send({ clientSecret: newSecret });
    },
  );

  // ── App ↔ User access management ─────────────────────────────────────────────

  // GET /api/admin/applications/:id/users — list all users associated with this app
  fastify.get<{ Params: { id: string } }>("/:id/users", async (req, reply) => {
    const rows = await db
      .select({
        userId: userApplications.userId,
        isActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
        createdAt: userApplications.createdAt,
        name: userTable.name,
        email: userTable.email,
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
      .where(eq(userApplications.applicationId, req.params.id));

    await reply.send({ users: rows });
  });

  // POST /api/admin/applications/:id/users — grant a user access to this app
  fastify.post<{ Params: { id: string } }>("/:id/users", async (req, reply) => {
    const parsed = grantUserAccessSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid data", parsed.error.flatten());

    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!app) throw ERR.APP_002();

    const [ua] = await db
      .insert(userApplications)
      .values({
        userId: parsed.data.userId,
        applicationId: req.params.id,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [userApplications.userId, userApplications.applicationId],
        set: { isActive: true },
      })
      .returning();

    if (parsed.data.roleId && ua) {
      await db
        .insert(userAppRoles)
        .values({
          userId: parsed.data.userId,
          applicationId: req.params.id,
          roleId: parsed.data.roleId,
        })
        .onConflictDoNothing();
    }

    // Auto-assign the app's default subscription plan if one is configured
    await assignDefaultPlanIfNeeded(parsed.data.userId, req.params.id);

    await reply.status(201).send({ ok: true });
  });

  // PATCH /api/admin/applications/:id/users/:userId — update user access (toggle, role, plan)
  fastify.patch<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId",
    async (req, reply) => {
      const parsed = updateUserAccessSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid data", parsed.error.flatten());

      if (parsed.data.isActive !== undefined) {
        await db
          .update(userApplications)
          .set({ isActive: parsed.data.isActive })
          .where(
            and(
              eq(userApplications.userId, req.params.userId),
              eq(userApplications.applicationId, req.params.id),
            ),
          );
      }

      if (parsed.data.roleId !== undefined) {
        await db
          .delete(userAppRoles)
          .where(
            and(
              eq(userAppRoles.userId, req.params.userId),
              eq(userAppRoles.applicationId, req.params.id),
            ),
          );
        if (parsed.data.roleId !== null) {
          await db
            .insert(userAppRoles)
            .values({
              userId: req.params.userId,
              applicationId: req.params.id,
              roleId: parsed.data.roleId,
            })
            .onConflictDoNothing();
        }
      }

      if (parsed.data.subscriptionPlanId !== undefined) {
        await db
          .update(userApplications)
          .set({ subscriptionPlanId: parsed.data.subscriptionPlanId })
          .where(
            and(
              eq(userApplications.userId, req.params.userId),
              eq(userApplications.applicationId, req.params.id),
            ),
          );
      }

      // When activating a user, auto-assign the default plan if none assigned yet
      if (parsed.data.isActive === true) {
        await assignDefaultPlanIfNeeded(req.params.userId, req.params.id);
      }

      await reply.send({ ok: true });
    },
  );

  // DELETE /api/admin/applications/:id/users/:userId — revoke user access
  fastify.delete<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId",
    async (req, reply) => {
      await db
        .delete(userApplications)
        .where(
          and(
            eq(userApplications.userId, req.params.userId),
            eq(userApplications.applicationId, req.params.id),
          ),
        );
      await reply.status(204).send();
    },
  );

  // GET /api/admin/applications/:id/consumption — consumption aggregates for this app
  fastify.get<{ Params: { id: string } }>(
    "/:id/consumption",
    async (req, reply) => {
      const rows = await db
        .select({
          userId: consumptionAggregates.userId,
          userName: userTable.name,
          userEmail: userTable.email,
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .leftJoin(userTable, eq(consumptionAggregates.userId, userTable.id))
        .where(eq(consumptionAggregates.applicationId, req.params.id))
        .orderBy(consumptionAggregates.userId, consumptionAggregates.key);

      await reply.send({ entries: rows });
    },
  );
}
