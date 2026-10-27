/**
 * Maps an application's subscription plan onto its gateway (LiteLLM) team.
 *
 * Every application gets one team per plan — `<appSlug>:<planSlug>` — so a
 * user's plan decides which models, MCP servers and agents they reach. The
 * slug is computed here only: the gateway asks auth-service (see the internal
 * `gateway` routes) for the team of a `(user, application)` pair, so no other
 * component has to reproduce the naming rule.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";

/** Plan name of the plan a new application is created with. */
export const DEFAULT_PLAN_NAME = "free";

/** Deterministic slug of a plan name, used to build gateway team ids. */
export function planSlug(planName: string): string {
  const slug = planName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "plan";
}

/** Gateway team id — and access-group name — of an application's plan. */
export function planTeamId(applicationSlug: string, planName: string): string {
  return `${applicationSlug}:${planSlug(planName)}`;
}

/** Human-readable team alias shown in the LiteLLM admin interface. */
export function planTeamAlias(
  applicationName: string,
  planName: string,
): string {
  return `${applicationName} - ${planName}`;
}

export interface GatewayPlan {
  applicationSlug: string;
  planName: string;
  teamId: string;
}

/**
 * Whether another plan of the same application already maps to this plan's
 * gateway team (its name slugifies identically). The team id and the access-group
 * name are derived from the slug, so a collision would merge two plans'
 * entitlements — the caller must reject such a create or rename.
 */
export async function planSlugConflict(
  applicationId: string,
  planName: string,
  exceptPlanId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, applicationId));
  const slug = planSlug(planName);
  return rows.some((r) => r.id !== exceptPlanId && planSlug(r.name) === slug);
}

/**
 * The plan a user holds for one application, and the gateway team it maps to:
 * the user's active (non-expired) subscription, or the application's default
 * plan. `null` when the application is unknown, is a system application (which
 * has no subscription plan), or grants the user no plan at all.
 */
export async function resolveGatewayPlan(
  userId: string,
  applicationSlug: string,
): Promise<GatewayPlan | null> {
  const [app] = await db
    .select({
      id: applications.id,
      isSystem: applications.isSystem,
    })
    .from(applications)
    .where(eq(applications.slug, applicationSlug))
    .limit(1);
  if (!app || app.isSystem) return null;

  const [active] = await db
    .select({
      name: subscriptionPlans.name,
      expiresAt: userSubscriptions.expiresAt,
    })
    .from(userSubscriptions)
    .innerJoin(
      subscriptionPlans,
      eq(userSubscriptions.planId, subscriptionPlans.id),
    )
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.applicationId, app.id),
        eq(userSubscriptions.isActive, true),
      ),
    )
    .limit(1);

  const expired =
    active?.expiresAt != null && active.expiresAt.getTime() <= Date.now();
  let planName = active && !expired ? active.name : null;

  if (!planName) {
    const [fallback] = await db
      .select({ name: subscriptionPlans.name })
      .from(subscriptionPlans)
      .where(
        and(
          eq(subscriptionPlans.applicationId, app.id),
          eq(subscriptionPlans.isDefault, true),
        ),
      )
      .limit(1);
    planName = fallback?.name ?? null;
  }

  if (!planName) return null;
  return {
    applicationSlug,
    planName,
    teamId: planTeamId(applicationSlug, planName),
  };
}
