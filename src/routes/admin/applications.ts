import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { generateId } from "better-auth";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  appRoles,
  userApplications,
  userAppRoles,
  consumptionAggregates,
  consumptionEntries,
  subscriptionPlans,
  userSubscriptions,
  loginHistory,
} from "../../db/schema.js";
import {
  assignDefaultRoleIfNeeded,
  assignDefaultPlanIfNeeded,
} from "../../services/claims.js";
import { oauthClient, user as userTable } from "../../db/auth-schema.js";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";
import { randomBytes, createHash } from "node:crypto";
import {
  addAudience,
  removeAudience,
  addCorsOrigin,
  removeCorsOrigin,
} from "../../runtime-config.js";

/** Hash a plaintext client secret using SHA-256 base64url (matches BetterAuth's defaultHasher). */
function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest().toString("base64url");
}

/**
 * `enableEndSession` and `postLogoutRedirectUris` live on the BetterAuth
 * `oauth_client` table, not on `applications`. The admin UI needs them in
 * every payload that exposes an application, so we fetch them by `clientId`
 * (= application slug) and merge them into the response.
 */
interface OauthClientView {
  enableEndSession: boolean;
  postLogoutRedirectUris: string[];
}

async function fetchOauthClientView(
  slug: string,
): Promise<OauthClientView> {
  const [row] = await db
    .select({
      enableEndSession: oauthClient.enableEndSession,
      postLogoutRedirectUris: oauthClient.postLogoutRedirectUris,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, slug))
    .limit(1);
  return {
    // Historical rows may have `enable_end_session = NULL`; treat absence as
    // disabled so the API never silently exposes a feature the operator did
    // not opt into.
    enableEndSession: row?.enableEndSession ?? false,
    postLogoutRedirectUris: row?.postLogoutRedirectUris ?? [],
  };
}

async function fetchOauthClientViews(
  slugs: string[],
): Promise<Map<string, OauthClientView>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({
      clientId: oauthClient.clientId,
      enableEndSession: oauthClient.enableEndSession,
      postLogoutRedirectUris: oauthClient.postLogoutRedirectUris,
    })
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, slugs));
  return new Map(
    rows.map((r) => [
      r.clientId,
      {
        enableEndSession: r.enableEndSession ?? false,
        postLogoutRedirectUris: r.postLogoutRedirectUris ?? [],
      },
    ]),
  );
}

function mergeOauthView<T extends { slug: string }>(
  app: T,
  view: OauthClientView,
): T & OauthClientView {
  return { ...app, ...view };
}

/**
 * Compute the effective `postLogoutRedirectUris` whitelist at create time.
 * If the operator did not provide any but supplied a `url`, seed it with the
 * canonical root URL (`${url}/`). This matches the most common SPA pattern
 * (BFF redirects the browser back to the app root after logout) and avoids a
 * silent post-logout failure where AuthService destroys the SSO session but
 * fails to redirect because no entry matches.
 */
function effectivePostLogoutRedirectUris(
  postLogoutRedirectUris: string[],
  url: string | null | undefined,
): string[] {
  if (postLogoutRedirectUris.length > 0) return postLogoutRedirectUris;
  if (!url) return [];
  const root = url.replace(/\/?$/, "/");
  return [root];
}

/**
 * Reserved JWT claim names that MUST NOT be overridden via per-application
 * metadata. These are managed by the OAuth provider itself.
 */
const RESERVED_JWT_CLAIMS = new Set([
  "sub",
  "aud",
  "iss",
  "exp",
  "iat",
  "nbf",
  "jti",
  "scope",
  "scopes",
  "azp",
  "client_id",
  "token_type",
  "auth_time",
  "acr",
  "amr",
]);

/**
 * Zod schema for the `metadata` field on applications. Values are restricted
 * to strings because they are surfaced to resource servers via the JWT
 * `client_attrs` field, whose contract requires string-typed entries (see
 * EMQX 5 JWT authn / client attributes spec). Keep keys to safe identifiers.
 */
const metadataSchema = z
  .record(z.string().max(256))
  .refine(
    (m) => Object.keys(m).every((k) => !RESERVED_JWT_CLAIMS.has(k)),
    { message: "metadata keys must not collide with reserved JWT claims" },
  )
  .refine(
    (m) => Object.keys(m).every((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)),
    { message: "metadata keys must be valid identifiers (letters, digits, underscore)" },
  );

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
  isPublic: z.boolean().default(false),
  skipConsent: z.boolean().default(false),
  isMfaRequired: z.boolean().default(false),
  allowRegister: z.boolean().default(true),
  allowedScopes: z.array(z.string()).default(["openid", "profile", "email"]),
  redirectUris: z.array(z.string().min(1)).default([]),
  // OIDC RP-Initiated Logout 1.0. When true, the client is allowed to call
  // /oauth2/end-session to terminate the AuthService SSO session. Required
  // for proper federated logout — without it, browsers retain the cookie and
  // silently re-authenticate the same user on the next /authorize round-trip.
  enableEndSession: z.boolean().default(true),
  // Whitelist of URLs that may be passed as `post_logout_redirect_uri` to
  // the end-session endpoint. Empty array = no post-logout redirect allowed.
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  url: z.string().url().optional().nullable(),
  icon: z.string().optional().nullable(),
  enabledSocialProviders: z
    .array(z.enum(["google", "github", "linkedin", "microsoft", "apple"]))
    .nullable()
    .optional(),
  metadata: metadataSchema.optional().default({}),
});

const updateAppSchema = createAppSchema.partial().omit({ slug: true, isPublic: true });

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

  // GET /api/admin/applications
  fastify.get("/", async (_req, reply) => {
    const rows = await db
      .select()
      .from(applications)
      .orderBy(applications.createdAt);
    const views = await fetchOauthClientViews(rows.map((r) => r.slug));
    const enriched = rows.map((r) =>
      mergeOauthView(
        r,
        views.get(r.slug) ?? { enableEndSession: false, postLogoutRedirectUris: [] },
      ),
    );
    await reply.send({ applications: enriched });
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

    // Generate and hash the client secret (only for confidential clients)
    const rawSecret = data.isPublic ? null : randomBytes(32).toString("hex");
    const hashedSecret = rawSecret ? hashClientSecret(rawSecret) : null;

    // Transactionally create the application row and the corresponding oauthClient row
    const [app] = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(applications)
        .values({
          name: data.name,
          slug: data.slug,
          description: data.description,
          isActive: data.isActive,
          isPublic: data.isPublic,
          skipConsent: data.skipConsent,
          isMfaRequired: data.isMfaRequired,
          allowRegister: data.allowRegister,
          allowedScopes: data.allowedScopes,
          redirectUris: data.redirectUris,
          url: data.url,
          icon: data.icon,
          enabledSocialProviders: data.enabledSocialProviders ?? null,
          metadata: data.metadata ?? {},
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
        enableEndSession: data.enableEndSession,
        postLogoutRedirectUris: effectivePostLogoutRedirectUris(
          data.postLogoutRedirectUris,
          data.url,
        ),
        public: data.isPublic || null,
        tokenEndpointAuthMethod: data.isPublic ? "none" : null,
        requirePKCE: data.isPublic ? true : null,
        metadata: { clientId: data.slug, applicationId: app.id },
      });

      return rows;
    });

    // ── Bootstrap macros ────────────────────────────────────────────────────
    // Run outside the main transaction so that failures here don't roll back
    // the application/oauthClient creation.

    // a) Create predefined roles: "user" (default) and "admin"
    const [userRole, adminRole] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(appRoles)
        .values([
          { applicationId: app!.id, name: "user", isDefault: true },
          { applicationId: app!.id, name: "admin", isDefault: false },
        ])
        .returning();
      return inserted;
    });

    // b) Create default "free" subscription plan
    const [freePlan] = await db
      .insert(subscriptionPlans)
      .values({
        applicationId: app!.id,
        name: "free",
        isDefault: true,
        features: {},
      })
      .returning();

    // c) Assign all existing superadmins to the app with the "admin" role and "free" plan
    if (adminRole && freePlan) {
      const superadmins = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.role, "superadmin"));

      for (const sa of superadmins) {
        // Grant access (upsert in case of edge-case duplicate)
        await db
          .insert(userApplications)
          .values({
            userId: sa.id,
            applicationId: app!.id,
            isActive: true,
            subscriptionPlanId: freePlan.id,
          })
          .onConflictDoUpdate({
            target: [userApplications.userId, userApplications.applicationId],
            set: { isActive: true, subscriptionPlanId: freePlan.id },
          });

        // Assign the "admin" role (not the default "user" role)
        await db
          .insert(userAppRoles)
          .values({
            userId: sa.id,
            applicationId: app!.id,
            roleId: adminRole.id,
          })
          .onConflictDoNothing();

        // Assign the "free" subscription
        await db
          .insert(userSubscriptions)
          .values({
            userId: sa.id,
            applicationId: app!.id,
            planId: freePlan.id,
            isActive: true,
          })
          .onConflictDoNothing();
      }
    }

    // Suppress unused variable warning for userRole (returned for completeness)
    void userRole;

    const response: Record<string, unknown> = {
      application: mergeOauthView(app!, {
        enableEndSession: data.enableEndSession,
        postLogoutRedirectUris: effectivePostLogoutRedirectUris(
          data.postLogoutRedirectUris,
          data.url,
        ),
      }),
      clientId: data.slug,
    };
    // Secret shown once — not persisted in plaintext. Public clients have no secret.
    if (rawSecret) response.clientSecret = rawSecret;

    // Register the app URL as a valid OAuth audience and CORS origin immediately.
    // This takes effect on the next request — no server restart required.
    if (data.url) {
      addAudience(data.url);
      addCorsOrigin(data.url);
    }

    await reply.status(201).send(response);
  });

  // GET /api/admin/applications/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!app) throw ERR.APP_002();
    const view = await fetchOauthClientView(app.slug);
    await reply.send({ application: mergeOauthView(app, view) });
  });

  // PATCH /api/admin/applications/:id
  fastify.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = updateAppSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid data", parsed.error.flatten());

    // Fetch the current URL before applying the update so we can diff it.
    const [before] = await db
      .select({ url: applications.url })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);

    // `enableEndSession` and `postLogoutRedirectUris` live exclusively on the
    // BetterAuth `oauthClient` row, not on `applications` \u2014 strip them before
    // updating the application table.
    const {
      enableEndSession: _ees,
      postLogoutRedirectUris: _plru,
      ...applicationData
    } = parsed.data;
    void _ees;
    void _plru;

    const [app] = await db
      .update(applications)
      .set({ ...applicationData, updatedAt: new Date() })
      .where(eq(applications.id, req.params.id))
      .returning();
    if (!app) throw ERR.APP_002();

    // Sync runtime-config when the URL field changes.
    if (parsed.data.url !== undefined && parsed.data.url !== before?.url) {
      // Remove old audience/origin if it was set
      if (before?.url) {
        removeAudience(before.url);
        removeCorsOrigin(before.url);
      }
      // Add new audience/origin if one was provided
      if (parsed.data.url) {
        addAudience(parsed.data.url);
        addCorsOrigin(parsed.data.url);
      }
    }

    // Sync relevant fields to the BetterAuth oauthClient table
    const oauthUpdate: Partial<typeof oauthClient.$inferInsert> = {};
    if (parsed.data.name !== undefined) oauthUpdate.name = parsed.data.name;
    if (parsed.data.allowedScopes !== undefined)
      oauthUpdate.scopes = parsed.data.allowedScopes;
    if (parsed.data.skipConsent !== undefined)
      oauthUpdate.skipConsent = parsed.data.skipConsent;
    if (parsed.data.redirectUris !== undefined)
      oauthUpdate.redirectUris = parsed.data.redirectUris;
    if (parsed.data.enableEndSession !== undefined)
      oauthUpdate.enableEndSession = parsed.data.enableEndSession;
    if (parsed.data.postLogoutRedirectUris !== undefined)
      oauthUpdate.postLogoutRedirectUris = parsed.data.postLogoutRedirectUris;

    if (Object.keys(oauthUpdate).length > 0) {
      await db
        .update(oauthClient)
        .set(oauthUpdate)
        .where(eq(oauthClient.clientId, app.slug));
    }

    const view = await fetchOauthClientView(app.slug);
    await reply.send({ application: mergeOauthView(app, view) });
  });

  // DELETE /api/admin/applications/:id
  // All related rows (roles, plans, user_applications, etc.) are cascade-deleted via FK constraints.
  fastify.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [deleted] = await db
      .delete(applications)
      .where(eq(applications.id, req.params.id))
      .returning({ id: applications.id, slug: applications.slug, url: applications.url });
    if (!deleted) throw ERR.APP_002();

    // Remove the oauthClient row (cascades to tokens/consents in BetterAuth tables)
    await db.delete(oauthClient).where(eq(oauthClient.clientId, deleted.slug));

    // Remove the URL from runtime-config.
    if (deleted.url) {
      removeAudience(deleted.url);
      removeCorsOrigin(deleted.url);
    }

    await reply.status(204).send();
  });

  // POST /api/admin/applications/:id/rotate-secret
  fastify.post<{ Params: { id: string } }>(
    "/:id/rotate-secret",
    async (req, reply) => {
      const [app] = await db
        .select({ id: applications.id, slug: applications.slug, isPublic: applications.isPublic })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      if (app.isPublic) {
        throw ERR.APP_001("Public clients do not have a client secret");
      }

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

  // GET /api/admin/applications/:id/users — list all users associated with this app.
  // Augments each row with `lastLoginAt` scoped to this application (computed
  // from `login_history`). A single grouped sub-select keeps this to one round
  // trip even when the membership list is large.
  fastify.get<{ Params: { id: string } }>("/:id/users", async (req, reply) => {
    const rows = await db
      .select({
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
      .where(eq(userApplications.applicationId, req.params.id));

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

    await reply.send({ users: enriched });
  });

  // GET /api/admin/applications/:id/users/:userId/history — paginated login
  // history for a single user inside a single application. Powers the history
  // modal opened from the row-action icon in the app users tab.
  fastify.get<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId/history",
    async (req, reply) => {
      const query = req.query as Record<string, string>;
      const page = Math.max(1, parseInt(query.page ?? "1", 10));
      const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10)));
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
      // Explicit role provided — assign it directly
      await db
        .insert(userAppRoles)
        .values({
          userId: parsed.data.userId,
          applicationId: req.params.id,
          roleId: parsed.data.roleId,
        })
        .onConflictDoNothing();
    } else {
      // No explicit role — auto-assign the default role if one is configured
      await assignDefaultRoleIfNeeded(parsed.data.userId, req.params.id);
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
      const { id: appId, userId } = req.params;
      await db.transaction(async (tx) => {
        await tx.delete(userAppRoles).where(
          and(eq(userAppRoles.userId, userId), eq(userAppRoles.applicationId, appId)),
        );
        await tx.delete(userSubscriptions).where(
          and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.applicationId, appId)),
        );
        await tx.delete(consumptionAggregates).where(
          and(eq(consumptionAggregates.userId, userId), eq(consumptionAggregates.applicationId, appId)),
        );
        await tx.delete(consumptionEntries).where(
          and(eq(consumptionEntries.userId, userId), eq(consumptionEntries.applicationId, appId)),
        );
        await tx.delete(userApplications).where(
          and(eq(userApplications.userId, userId), eq(userApplications.applicationId, appId)),
        );
      });
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

  // PATCH /api/admin/applications/:id/providers — update per-app social providers
  const updateProvidersSchema = z.object({
    enabledSocialProviders: z
      .array(z.enum(["google", "github", "linkedin", "microsoft", "apple"]))
      .nullable(),
  });

  fastify.patch<{ Params: { id: string } }>(
    "/:id/providers",
    async (req, reply) => {
      const parsed = updateProvidersSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ERR.APP_001("Invalid providers data");
      }

      const [app] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      const [updated] = await db
        .update(applications)
        .set({ enabledSocialProviders: parsed.data.enabledSocialProviders })
        .where(eq(applications.id, req.params.id))
        .returning();

      await reply.send({ application: updated });
    },
  );
}
