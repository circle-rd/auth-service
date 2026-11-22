import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  appRoles,
  userApplications,
  userAppRoles,
  consumptionAggregates,
  consumptionEntries,
  userSubscriptions,
} from "../../db/schema.js";
import { assignDefaultRoleIfNeeded } from "../../services/claims.js";
import {
  assertPlanBelongsToApp,
  assignDefaultPlanIfNeeded,
  getCurrentSubscriptionPlanId,
  setUserSubscription,
} from "../../services/subscriptions.js";
import {
  assignRequestedOrDefaultPlan,
  planChangeReasonRequired,
  subscriptionReasonSchema,
} from "./subscription-request.js";
import { member, user as userTable } from "../../db/auth-schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { revokeUserClientTokens } from "../../services/oauth-tokens.js";
import { getActorUserId } from "../../middleware.js";

/**
 * Ensure a role belongs to the given application before it is assigned to a
 * user. Without this check an admin could attach a `roleId` from a different
 * application (the `userAppRoles` insert does not constrain the role's owning
 * app), leaking that app's role name / permissions into the target app's
 * tokens via `getUserClaims`. Throws APP_001 on mismatch or unknown role.
 */
async function assertRoleBelongsToApp(
  roleId: string,
  applicationId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: appRoles.id })
    .from(appRoles)
    .where(
      and(eq(appRoles.id, roleId), eq(appRoles.applicationId, applicationId)),
    )
    .limit(1);
  if (!row) {
    throw ERR.APP_001("Role does not belong to this application");
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const grantUserAccessSchema = z.object({
  userId: z.string().min(1),
  roleId: z.string().uuid().optional(),
  // When omitted the application's default plan is assigned instead.
  subscriptionPlanId: z.string().uuid().optional(),
  reason: subscriptionReasonSchema.optional(),
});

const bulkGrantUserAccessSchema = z
  .object({
    // Either every member of an organization…
    organizationId: z.string().min(1).optional(),
    // …or an explicit list of user ids.
    userIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
    roleId: z.string().uuid().optional(),
    // Applied to every granted user; the app default plan is used when omitted.
    subscriptionPlanId: z.string().uuid().optional(),
    reason: subscriptionReasonSchema.optional(),
  })
  .refine((d) => Boolean(d.organizationId) !== Boolean(d.userIds), {
    message: "Provide exactly one of organizationId or userIds",
  });

const updateUserAccessSchema = z
  .object({
    isActive: z.boolean().optional(),
    roleId: z.string().uuid().optional().nullable(),
    subscriptionPlanId: z.string().uuid().optional().nullable(),
    expiresAt: z.string().datetime().optional().nullable(),
    // A manual plan change is audited, so it must carry a reason.
    reason: subscriptionReasonSchema.optional(),
  })
  .refine((d) => !planChangeReasonRequired(d), {
    message: "reason is required when changing the subscription plan",
    path: ["reason"],
  });

export async function applicationUserAccessRoutes(
  fastify: FastifyInstance,
): Promise<void> {
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

    // Validate the plan up front so an unknown/foreign plan fails before we
    // grant access (fail-fast; no half-applied request).
    if (parsed.data.subscriptionPlanId) {
      await assertPlanBelongsToApp(
        parsed.data.subscriptionPlanId,
        req.params.id,
      );
    }

    const [existingAccess] = await db
      .select({ subscriptionPlanId: userApplications.subscriptionPlanId })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, parsed.data.userId),
          eq(userApplications.applicationId, req.params.id),
        ),
      )
      .limit(1);

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
      // Explicit role provided — replace the user's current role after
      // verifying the new one belongs to this application (prevents cross-app
      // role injection). "Grant access" doubles as "change role" for a user who
      // already has access; leaving the old row would silently ignore the edit.
      await assertRoleBelongsToApp(parsed.data.roleId, req.params.id);
      await db.transaction(async (tx) => {
        await tx
          .delete(userAppRoles)
          .where(
            and(
              eq(userAppRoles.userId, parsed.data.userId),
              eq(userAppRoles.applicationId, req.params.id),
            ),
          );
        await tx.insert(userAppRoles).values({
          userId: parsed.data.userId,
          applicationId: req.params.id,
          roleId: parsed.data.roleId!,
        });
      });
    } else {
      // No explicit role — auto-assign the default role if one is configured
      await assignDefaultRoleIfNeeded(parsed.data.userId, req.params.id);
    }

    // Assign the requested plan, else fall back to the app's default plan.
    // For a user who already has a plan, a role-only edit must not touch their
    // subscription (and therefore must not write to Stripe): only an explicit
    // change of plan is applied. A user with no plan still gets the default.
    const planId = parsed.data.subscriptionPlanId;
    const planNeedsAssignment =
      !existingAccess ||
      (planId !== undefined
        ? planId !== existingAccess.subscriptionPlanId
        : existingAccess.subscriptionPlanId === null);
    if (planNeedsAssignment) {
      await assignRequestedOrDefaultPlan({
        userId: parsed.data.userId,
        applicationId: req.params.id,
        planId,
        actorUserId: await getActorUserId(req),
        reason: parsed.data.reason ?? null,
      });
    }

    await reply.status(201).send({ ok: true });
  });
  // POST /api/admin/applications/:id/users/bulk — grant many users at once
  fastify.post<{ Params: { id: string } }>(
    "/:id/users/bulk",
    async (req, reply) => {
      const parsed = bulkGrantUserAccessSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid data", parsed.error.flatten());

      const [app] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      // Resolve the candidate users (id + email). Email lets us skip accounts
      // that already have access through a duplicate user record.
      let candidates: Array<{ id: string; email: string }>;
      if (parsed.data.organizationId) {
        candidates = await db
          .select({ id: userTable.id, email: userTable.email })
          .from(member)
          .innerJoin(userTable, eq(member.userId, userTable.id))
          .where(eq(member.organizationId, parsed.data.organizationId));
        if (candidates.length === 0) {
          throw ERR.APP_001("This organization has no members");
        }
      } else {
        const ids = [...new Set(parsed.data.userIds ?? [])];
        candidates = await db
          .select({ id: userTable.id, email: userTable.email })
          .from(userTable)
          .where(inArray(userTable.id, ids));
      }

      // Dedupe within the request, then drop anyone who already has access.
      const uniqueCandidates = [
        ...new Map(candidates.map((c) => [c.id, c])).values(),
      ];
      const existing = await db
        .select({ userId: userApplications.userId, email: userTable.email })
        .from(userApplications)
        .leftJoin(userTable, eq(userApplications.userId, userTable.id))
        .where(eq(userApplications.applicationId, req.params.id));
      const existingIds = new Set(existing.map((e) => e.userId));
      const existingEmails = new Set(
        existing
          .map((e) => (e.email ?? "").toLowerCase())
          .filter((e) => e !== ""),
      );
      const toGrant = uniqueCandidates.filter(
        (c) =>
          !existingIds.has(c.id) && !existingEmails.has(c.email.toLowerCase()),
      );
      const skipped = uniqueCandidates.length - toGrant.length;

      if (parsed.data.roleId) {
        await assertRoleBelongsToApp(parsed.data.roleId, req.params.id);
      }
      // Validate the plan before granting anything, so an unknown/foreign plan
      // cannot leave a batch of access rows behind a 404.
      if (parsed.data.subscriptionPlanId) {
        await assertPlanBelongsToApp(
          parsed.data.subscriptionPlanId,
          req.params.id,
        );
      }

      if (toGrant.length === 0) {
        await reply.status(200).send({ granted: 0, skipped });
        return;
      }

      await db
        .insert(userApplications)
        .values(
          toGrant.map((c) => ({
            userId: c.id,
            applicationId: req.params.id,
            isActive: true,
          })),
        )
        .onConflictDoUpdate({
          target: [userApplications.userId, userApplications.applicationId],
          set: { isActive: true },
        });

      const actorId = await getActorUserId(req);

      for (const { id: userId } of toGrant) {
        if (parsed.data.roleId) {
          await db
            .insert(userAppRoles)
            .values({
              userId,
              applicationId: req.params.id,
              roleId: parsed.data.roleId,
            })
            .onConflictDoNothing();
        } else {
          await assignDefaultRoleIfNeeded(userId, req.params.id);
        }
        await assignRequestedOrDefaultPlan({
          userId,
          applicationId: req.params.id,
          planId: parsed.data.subscriptionPlanId,
          actorUserId: actorId,
          reason: parsed.data.reason ?? null,
        });
      }

      await reply.status(201).send({ granted: toGrant.length, skipped });
    },
  );
  // PATCH /api/admin/applications/:id/users/:userId — update user access (toggle, role, plan)
  fastify.patch<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId",
    async (req, reply) => {
      const parsed = updateUserAccessSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid data", parsed.error.flatten());

      const { subscriptionPlanId, expiresAt } = parsed.data;
      const writesPlan = subscriptionPlanId !== undefined;
      const writesExpiry = expiresAt !== undefined;

      // Validate the plan up front — before the access row or the role is
      // mutated — so a foreign/unknown plan cannot leave a half-applied request.
      if (typeof subscriptionPlanId === "string") {
        await assertPlanBelongsToApp(subscriptionPlanId, req.params.id);
      }

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

        // Revoking access must also burn the user's OAuth refresh tokens for
        // this app, otherwise they keep minting access tokens indefinitely.
        // Scoped to one app by design: it must not end the shared SSO session.
        // No back-channel logout is sent here — that fires on session end —
        // so the application learns at the next refresh attempt.
        if (parsed.data.isActive === false) {
          const [app] = await db
            .select({ slug: applications.slug })
            .from(applications)
            .where(eq(applications.id, req.params.id))
            .limit(1);
          if (app) {
            await revokeUserClientTokens(req.params.userId, app.slug);
          }
        }
      }

      if (parsed.data.roleId !== undefined) {
        // Validate the new role (when provided) BEFORE mutating anything, so a
        // bad roleId cannot strip the user's current role as a side effect.
        if (parsed.data.roleId !== null) {
          await assertRoleBelongsToApp(parsed.data.roleId, req.params.id);
        }
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

      if (writesPlan || writesExpiry) {
        // An expiry-only payload keeps the current plan; a plan payload with a
        // null plan revokes the subscription.
        const planId = writesPlan
          ? subscriptionPlanId
          : await getCurrentSubscriptionPlanId(
              req.params.userId,
              req.params.id,
            );
        if (writesPlan || planId !== null) {
          await setUserSubscription({
            userId: req.params.userId,
            applicationId: req.params.id,
            planId,
            source: "admin",
            actorUserId: await getActorUserId(req),
            reason: parsed.data.reason ?? null,
            expiresAt: writesExpiry
              ? expiresAt
                ? new Date(expiresAt)
                : null
              : undefined,
          });
        }
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

      // Burn the user's OAuth tokens for this app before deleting the access
      // rows, so a held refresh token cannot resurrect the grant.
      const [app] = await db
        .select({ slug: applications.slug })
        .from(applications)
        .where(eq(applications.id, appId))
        .limit(1);
      if (app) {
        await revokeUserClientTokens(userId, app.slug);
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(userAppRoles)
          .where(
            and(
              eq(userAppRoles.userId, userId),
              eq(userAppRoles.applicationId, appId),
            ),
          );
        await tx
          .delete(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.userId, userId),
              eq(userSubscriptions.applicationId, appId),
            ),
          );
        await tx
          .delete(consumptionAggregates)
          .where(
            and(
              eq(consumptionAggregates.userId, userId),
              eq(consumptionAggregates.applicationId, appId),
            ),
          );
        await tx
          .delete(consumptionEntries)
          .where(
            and(
              eq(consumptionEntries.userId, userId),
              eq(consumptionEntries.applicationId, appId),
            ),
          );
        await tx
          .delete(userApplications)
          .where(
            and(
              eq(userApplications.userId, userId),
              eq(userApplications.applicationId, appId),
            ),
          );
      });
      await reply.status(204).send();
    },
  );
}
