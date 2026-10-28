import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  userApplications,
  applications,
  subscriptionPlans,
  subscriptionPlanPrices,
  consumptionAggregates,
} from "../db/schema.js";
import {
  session as sessionTable,
  user as userTable,
  member as memberTable,
  organization as organizationTable,
} from "../db/auth-schema.js";
import { and, eq, gt, inArray } from "drizzle-orm";
import { ERR } from "../errors.js";
import { auth } from "../auth.js";
import { requireSession, requireFullSession } from "../middleware.js";
import { publishEvent } from "../services/event-bus.js";
import { isStripeConfigured } from "../services/stripe.js";
import { setUserSubscription } from "../services/subscriptions.js";
import { listInvoices } from "../services/billing/invoices.js";
import { getApplicationUsage } from "../services/billing/app-views.js";
import { syncBillingCustomerBestEffort } from "../services/billing/customers.js";
import { profileFieldsSchema, profileUpdateSet } from "./profile-fields.js";
import {
  createBillingPortalUrl,
  createSubscriptionCheckout,
  planIsPaid,
  readLinkedSubscription,
  switchSubscriptionPlan,
  syncStripeSubscription,
} from "../services/billing/subscriptions.js";

const updateProfileSchema = profileFieldsSchema;

const changePlanSchema = z.object({
  planId: z.string().uuid(),
});

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/user/subscription
  // Returns the current user's app access list with plan details, the plans
  // available per application (for the self-service selector) and whether
  // Stripe is configured (the selector is hidden when it is not).
  fastify.get("/subscription", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;

    const rows = await db
      .select({
        applicationId: userApplications.applicationId,
        appName: applications.name,
        appSlug: applications.slug,
        appIcon: applications.icon,
        appUrl: applications.url,
        userIsActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
      })
      .from(userApplications)
      .innerJoin(
        applications,
        eq(userApplications.applicationId, applications.id),
      )
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.isActive, true),
          eq(applications.isSystem, false),
        ),
      )
      .orderBy(applications.name);

    const appIds = rows.map((r) => r.applicationId);

    const plans = appIds.length
      ? await db
          .select()
          .from(subscriptionPlans)
          .where(inArray(subscriptionPlans.applicationId, appIds))
      : [];

    const allPrices = plans.length
      ? await db
          .select()
          .from(subscriptionPlanPrices)
          .where(
            inArray(
              subscriptionPlanPrices.planId,
              plans.map((p) => p.id),
            ),
          )
      : [];

    const pricesByPlan = new Map<string, typeof allPrices>();
    for (const price of allPrices) {
      const list = pricesByPlan.get(price.planId) ?? [];
      list.push(price);
      pricesByPlan.set(price.planId, list);
    }

    const toPlanView = (plan: (typeof plans)[number]) => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      features: plan.features ?? {},
      isDefault: plan.isDefault,
      prices: (pricesByPlan.get(plan.id) ?? []).map((price) => ({
        id: price.id,
        planId: price.planId,
        name: price.name,
        amount: price.amount,
        currency: price.currency,
        interval: price.interval as "month" | "year" | "one_time",
        stripePriceId: price.stripePriceId,
        createdAt: price.createdAt.toISOString(),
      })),
    });

    const plansById = new Map(plans.map((p) => [p.id, p]));

    const subscriptions = rows.map((r) => {
      const current = r.subscriptionPlanId
        ? plansById.get(r.subscriptionPlanId)
        : undefined;
      return {
        applicationId: r.applicationId,
        applicationName: r.appName,
        applicationSlug: r.appSlug,
        applicationIcon: r.appIcon,
        applicationUrl: r.appUrl,
        isActive: r.userIsActive,
        plan: current ? toPlanView(current) : null,
        availablePlans: plans
          .filter((p) => p.applicationId === r.applicationId)
          .map(toPlanView),
      };
    });

    await reply.send({
      subscriptions,
      stripeConfigured: isStripeConfigured(),
    });
  });

  // PATCH /api/user/subscription/:applicationId
  // Self-service plan change. Hidden and refused unless Stripe is configured:
  // without a payment provider only administrators change a user's plan. A paid
  // target is never granted for free: an existing paid subscription is switched
  // in place, otherwise the caller is sent to Stripe Checkout.
  fastify.patch<{ Params: { applicationId: string } }>(
    "/subscription/:applicationId",
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;

      if (!isStripeConfigured()) throw ERR.SUB_005();

      const parsed = changePlanSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid plan change", parsed.error.flatten());

      const { applicationId } = req.params;

      // The user may only change the plan of an application they can access.
      const [access] = await db
        .select({ id: userApplications.id })
        .from(userApplications)
        .where(
          and(
            eq(userApplications.userId, userId),
            eq(userApplications.applicationId, applicationId),
            eq(userApplications.isActive, true),
          ),
        )
        .limit(1);
      if (!access) throw ERR.APP_005();

      if (await planIsPaid(parsed.data.planId)) {
        // A paid plan is never granted locally before Stripe agrees. A live paid
        // subscription changes in place (prorated by Stripe, the plan follows its
        // update event); any other case goes through Checkout, and the plan is
        // granted by the checkout's completion event.
        const linked = await readLinkedSubscription(userId, applicationId);
        if (
          linked?.isActive &&
          linked.stripeSubscriptionId &&
          (await planIsPaid(linked.planId))
        ) {
          await switchSubscriptionPlan({
            userId,
            applicationId,
            planId: parsed.data.planId,
          });
          await reply.send({
            ok: true,
            changed: false,
            pending: true,
            checkoutUrl: null,
          });
          return;
        }
        const checkout = await createSubscriptionCheckout({
          userId,
          applicationId,
          planId: parsed.data.planId,
        });
        await reply.send({
          ok: true,
          changed: false,
          pending: false,
          checkoutUrl: checkout.url,
        });
        return;
      }

      // A free plan takes effect at once; its Stripe subscription follows.
      const change = await setUserSubscription({
        userId,
        applicationId,
        planId: parsed.data.planId,
        source: "self",
        actorUserId: userId,
      });
      await syncStripeSubscription({
        userId,
        applicationId,
        planId: parsed.data.planId,
      });

      await reply.send({
        ok: true,
        changed: change.changed,
        pending: false,
        checkoutUrl: null,
      });
    },
  );

  const checkoutBodySchema = z.object({
    applicationId: z.string().uuid(),
    planId: z.string().uuid(),
  });

  // POST /api/user/billing/checkout — open a Stripe Checkout in subscription
  // mode for a paid plan. The session needs the user's session (not a bearer
  // token): the subscription is bound to their Stripe Customer.
  fastify.post("/billing/checkout", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const parsed = checkoutBodySchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.APP_001("Invalid checkout request", parsed.error.flatten());
    const [access] = await db
      .select({ id: userApplications.id })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.applicationId, parsed.data.applicationId),
          eq(userApplications.isActive, true),
        ),
      )
      .limit(1);
    if (!access) throw ERR.APP_005();
    await reply.send(
      await createSubscriptionCheckout({ userId, ...parsed.data }),
    );
  });

  const invoicesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(512).optional(),
  });

  // GET /api/user/billing/invoices?limit=&cursor=
  // The caller's Stripe invoices, every application and wallet top-ups alike,
  // newest first. Their own invoices only: the caller is the owner.
  fastify.get("/billing/invoices", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const query = invoicesQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw ERR.APP_001("Invalid query", query.error.flatten());
    }
    await reply.send(
      await listInvoices({
        userId,
        limit: query.data.limit,
        cursor: query.data.cursor,
      }),
    );
  });

  // GET /api/user/billing/usage?applicationId=
  // Metered usage of the current period for one application the caller uses.
  fastify.get("/billing/usage", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const query = z
      .object({ applicationId: z.string().uuid() })
      .safeParse(req.query);
    if (!query.success) {
      throw ERR.APP_001("Invalid query", query.error.flatten());
    }
    const [access] = await db
      .select({ id: userApplications.id })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.applicationId, query.data.applicationId),
          eq(userApplications.isActive, true),
        ),
      )
      .limit(1);
    if (!access) throw ERR.APP_005();
    await reply.send(
      await getApplicationUsage({
        userId,
        applicationId: query.data.applicationId,
      }),
    );
  });

  // POST /api/user/billing/portal — Stripe Billing Portal (payment methods,
  // cancellation), on the user's Stripe Customer.
  fastify.post("/billing/portal", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    await reply.send(await createBillingPortalUrl({ userId }));
  });

  // GET /api/user/consumption/:appId
  // Returns the current user's consumption aggregates for a specific app.
  fastify.get<{ Params: { appId: string } }>(
    "/consumption/:appId",
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;

      // Verify user has access to this app
      const [access] = await db
        .select({ id: userApplications.id })
        .from(userApplications)
        .where(
          and(
            eq(userApplications.userId, userId),
            eq(userApplications.applicationId, req.params.appId),
          ),
        )
        .limit(1);
      if (!access) throw ERR.APP_005();

      const aggregates = await db
        .select({
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, userId),
            eq(consumptionAggregates.applicationId, req.params.appId),
          ),
        )
        .orderBy(consumptionAggregates.key);

      await reply.send({ aggregates });
    },
  );

  // GET /api/user/sessions
  // Returns the current user's active sessions.
  fastify.get("/sessions", async (req, reply) => {
    const ctx = await requireFullSession(req, reply);
    if (!ctx) return;

    const now = new Date();
    const sessions = await db
      .select({
        id: sessionTable.id,
        userId: sessionTable.userId,
        userAgent: sessionTable.userAgent,
        ipAddress: sessionTable.ipAddress,
        createdAt: sessionTable.createdAt,
        expiresAt: sessionTable.expiresAt,
      })
      .from(sessionTable)
      .where(
        and(
          eq(sessionTable.userId, ctx.userId),
          gt(sessionTable.expiresAt, now),
        ),
      )
      .orderBy(sessionTable.createdAt);

    await reply.send({ sessions, currentSessionId: ctx.sessionId });
  });

  // DELETE /api/user/sessions/:id
  // Revoke one of the current user's sessions (cannot revoke a foreign user's session).
  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    async (req, reply) => {
      const ctx = await requireFullSession(req, reply);
      if (!ctx) return;

      // Verify the target session belongs to the current user
      const [target] = await db
        .select({
          id: sessionTable.id,
          userId: sessionTable.userId,
          token: sessionTable.token,
        })
        .from(sessionTable)
        .where(eq(sessionTable.id, req.params.id))
        .limit(1);

      if (!target || target.userId !== ctx.userId) {
        throw ERR.AUTH_016();
      }

      // Route through BetterAuth so any plugin-managed session side effects
      // (cookie invalidation, downstream hooks) still run.
      await auth.api.revokeSession({
        headers: fromNodeHeaders(req.headers),
        body: { token: target.token },
      });

      await reply.status(204).send();
    },
  );

  // GET /api/user/organizations
  // Returns the organizations the current user is a member of.
  fastify.get("/organizations", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;

    const rows = await db
      .select({
        id: organizationTable.id,
        name: organizationTable.name,
        slug: organizationTable.slug,
        logo: organizationTable.logo,
        createdAt: organizationTable.createdAt,
        role: memberTable.role,
      })
      .from(memberTable)
      .innerJoin(
        organizationTable,
        eq(organizationTable.id, memberTable.organizationId),
      )
      .where(eq(memberTable.userId, userId))
      .orderBy(organizationTable.name);

    await reply.send({ organizations: rows });
  });

  // PATCH /api/user/profile
  // Allows any authenticated user to update their own profile fields.
  fastify.patch("/profile", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;

    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ERR.USR_003("Invalid profile data", parsed.error.flatten());
    }

    await db
      .update(userTable)
      .set({
        ...profileUpdateSet(parsed.data),
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, userId));

    // A self-service profile edit is a user write like any other: the admin user
    // list renders these fields, so it must refresh too.
    publishEvent("user.changed");
    // The Stripe Customer must carry the same identity as the local profile.
    await syncBillingCustomerBestEffort("user", userId);

    await reply.send({ ok: true });
  });
}
