/**
 * Keeps the gateway teams in line with the applications and their plans.
 *
 * An application has LiteLLM support when the URL of the `litellm` application
 * (the gateway, a protected resource) is in its `allowedResources`: that is what
 * lets it obtain tokens the gateway accepts, and what the "LiteLLM support"
 * switch of the admin form sets. Each of its plans then gets a team (and the
 * empty access group that carries it), so a gateway administrator can give one
 * plan its own models, MCP servers and agents.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, subscriptionPlans } from "../db/schema.js";
import { config } from "../config.js";
import { ERR } from "../errors.js";
import { logger } from "../logger.js";
import {
  LitellmGatewayError,
  MANAGED_BY,
  blockTeam,
  deleteAccessGroupByName,
  deleteTeam,
  ensurePlanTeam,
  isGatewayConfigured,
  listTeams,
} from "./litellm-teams.js";
import { planTeamAlias, planTeamId } from "./litellm-plan.js";
import { LITELLM_GATEWAY_SLUG } from "./system-apps.js";

const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** URL of the gateway application, or null when there is none (no gateway deployed). */
export async function gatewayUrl(): Promise<string | null> {
  const [row] = await db
    .select({ url: applications.url })
    .from(applications)
    .where(eq(applications.slug, LITELLM_GATEWAY_SLUG))
    .limit(1);
  return row?.url ?? null;
}

export function supportsLitellm(
  allowedResources: string[],
  gateway: string | null,
): boolean {
  return gateway !== null && allowedResources.includes(gateway);
}

/** Whether this service takes care of gateway teams at all. */
async function active(): Promise<string | null> {
  if (!isGatewayConfigured()) return null;
  return gatewayUrl();
}

interface AppLike {
  slug: string;
  name: string;
  allowedResources: string[];
}

const PLAN_TEAM_SEPARATOR = ":";

async function planNames(applicationId: string): Promise<string[]> {
  const rows = await db
    .select({ name: subscriptionPlans.name })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.applicationId, applicationId));
  return rows.map((r) => r.name);
}

async function appBySlug(
  slug: string,
): Promise<(AppLike & { id: string; isSystem: boolean }) | null> {
  const [app] = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      allowedResources: applications.allowedResources,
      isSystem: applications.isSystem,
    })
    .from(applications)
    .where(eq(applications.slug, slug))
    .limit(1);
  return app ?? null;
}

async function appById(
  id: string,
): Promise<(AppLike & { id: string; isSystem: boolean }) | null> {
  const [app] = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      allowedResources: applications.allowedResources,
      isSystem: applications.isSystem,
    })
    .from(applications)
    .where(eq(applications.id, id))
    .limit(1);
  return app ?? null;
}

async function ensurePlanTeamFor(
  app: Pick<AppLike, "slug" | "name">,
  planName: string,
): Promise<void> {
  const teamId = planTeamId(app.slug, planName);
  await ensurePlanTeam(teamId, planTeamAlias(app.name, planName), teamId);
}

/** Teams auth-service manages for one application (its id is `<slug>:<plan>`). */
function teamsOfApplication<T extends { team_id: string }>(
  teams: T[],
  slug: string,
): T[] {
  return teams.filter((t) =>
    t.team_id.startsWith(`${slug}${PLAN_TEAM_SEPARATOR}`),
  );
}

/** Managed teams of one application: never touch a team an administrator made. */
function managedTeamsOfApplication(
  teams: Array<{ team_id: string; metadata?: Record<string, unknown> | null }>,
  slug: string,
): string[] {
  return teamsOfApplication(teams, slug)
    .filter((t) => t.metadata?.managed_by === MANAGED_BY)
    .map((t) => t.team_id);
}

/** Block or delete every gateway team (and access group) auth-service manages. */
async function retireApplicationTeams(
  slug: string,
  mode: "block" | "delete",
): Promise<void> {
  const teamIds = managedTeamsOfApplication(await listTeams(), slug);
  for (const teamId of teamIds) {
    if (mode === "delete") {
      await deleteTeam(teamId);
      await deleteAccessGroupByName(teamId);
    } else {
      await blockTeam(teamId);
    }
  }
}

/**
 * Before an application is saved with LiteLLM support it did not have: the
 * teams of all its plans must exist, otherwise the application would get tokens
 * the gateway then refuses. `previousResources` is what it could request before
 * the save (`[]` for a new one); `plans` is a new application's plans, which do
 * not exist in the database yet. Throws `SRV_004` and nothing is saved when the
 * gateway cannot do it.
 */
export async function ensureTeamBeforeSave(
  app: AppLike,
  previousResources: string[],
  plans?: string[],
): Promise<void> {
  const gateway = await active();
  if (
    !supportsLitellm(app.allowedResources, gateway) ||
    supportsLitellm(previousResources, gateway)
  ) {
    return;
  }
  try {
    let names = plans;
    if (!names) {
      const row = await appBySlug(app.slug);
      names = row ? await planNames(row.id) : [];
    }
    for (const name of names) await ensurePlanTeamFor(app, name);
  } catch (err) {
    if (err instanceof LitellmGatewayError) throw ERR.SRV_004(err.message);
    throw err;
  }
}

/**
 * After a save, or a deletion (`next` is null): cut the teams of an application
 * that lost its support. The save already stopped new tokens, so a failure only
 * warns (the reconciler retries). A deleted application's teams are deleted, an
 * edited one's are blocked.
 */
export async function retireTeamAfterSave(
  slug: string,
  previousResources: string[],
  next: string[] | null,
): Promise<void> {
  const gateway = await active();
  if (
    !supportsLitellm(previousResources, gateway) ||
    (next !== null && supportsLitellm(next, gateway))
  ) {
    return;
  }
  try {
    await retireApplicationTeams(slug, next === null ? "delete" : "block");
  } catch (err) {
    logger.warn(
      { err: String(err), slug },
      "[litellm] could not retire the gateway teams; the reconciler will retry",
    );
  }
}

/**
 * Before a plan is created (or renamed): its team must exist if the application
 * has LiteLLM support. Throws `SRV_004` and nothing is saved when the gateway
 * cannot do it.
 */
export async function ensurePlanTeamBeforeSave(
  applicationId: string,
  planName: string,
): Promise<void> {
  const gateway = await active();
  const app = await appById(applicationId);
  if (!app || app.isSystem || !supportsLitellm(app.allowedResources, gateway)) {
    return;
  }
  try {
    await ensurePlanTeamFor(app, planName);
  } catch (err) {
    if (err instanceof LitellmGatewayError) throw ERR.SRV_004(err.message);
    throw err;
  }
}

/** After a plan is removed (or renamed away): block its team, drop its group. */
export async function retirePlanTeam(
  applicationId: string,
  planName: string,
): Promise<void> {
  const gateway = await active();
  const app = await appById(applicationId);
  if (!app || !supportsLitellm(app.allowedResources, gateway)) return;
  const teamId = planTeamId(app.slug, planName);
  try {
    await blockTeam(teamId);
    await deleteAccessGroupByName(teamId);
  } catch (err) {
    logger.warn(
      { err: String(err), teamId },
      "[litellm] could not retire the plan team; the reconciler will retry",
    );
  }
}

/**
 * After a plan rename: retire the previous team (and its group), unless the new
 * name maps to the same team — which happens when the rename only changes case
 * or separators (`Free` -> `free`). Retiring then would block the live team and
 * delete an administrator's access group for nothing.
 */
export async function retireRenamedPlanTeam(
  applicationId: string,
  previousName: string,
  nextName: string,
): Promise<void> {
  const app = await appById(applicationId);
  if (!app) return;
  if (planTeamId(app.slug, previousName) === planTeamId(app.slug, nextName)) {
    return;
  }
  await retirePlanTeam(applicationId, previousName);
}

export interface ReconcileReport {
  ensured: string[];
  blocked: string[];
  failed: string[];
}

/**
 * Bring the gateway teams in line with the applications and their plans: every
 * plan of an application with LiteLLM support has a usable team, and a team
 * auth-service manages whose plan (or application) no longer exists is blocked.
 * Teams made by hand in the gateway are left alone.
 */
export async function reconcileLitellmTeams(): Promise<ReconcileReport> {
  const report: ReconcileReport = { ensured: [], blocked: [], failed: [] };
  const gateway = await active();
  if (!gateway) return report;

  const apps = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      name: applications.name,
      allowedResources: applications.allowedResources,
      isSystem: applications.isSystem,
    })
    .from(applications);
  const desired = new Set<string>();
  for (const app of apps) {
    if (app.isSystem || !supportsLitellm(app.allowedResources, gateway)) {
      continue;
    }
    for (const name of await planNames(app.id)) {
      const teamId = planTeamId(app.slug, name);
      desired.add(teamId);
      try {
        await ensurePlanTeamFor(app, name);
        report.ensured.push(teamId);
      } catch (err) {
        report.failed.push(teamId);
        logger.warn(
          { err: String(err), teamId },
          "[litellm] plan team sync failed",
        );
      }
    }
  }

  let teams;
  try {
    teams = await listTeams();
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "[litellm] could not list the gateway teams",
    );
    return report;
  }
  for (const team of teams) {
    const managed = team.metadata?.managed_by === MANAGED_BY;
    if (!managed || desired.has(team.team_id) || team.blocked) continue;
    try {
      await blockTeam(team.team_id);
      report.blocked.push(team.team_id);
    } catch (err) {
      report.failed.push(team.team_id);
      logger.warn(
        { err: String(err), teamId: team.team_id },
        "[litellm] plan team block failed",
      );
    }
  }
  return report;
}

/** Reconcile now (in the background) and every few minutes. Never throws. */
export function startLitellmReconciler(): void {
  if (!config.litellm.url) return;
  const run = () =>
    reconcileLitellmTeams()
      .then((r) => {
        if (r.ensured.length + r.blocked.length + r.failed.length > 0) {
          logger.info(r, "[litellm] gateway teams reconciled");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err: String(err) }, "[litellm] reconcile failed"),
      );
  void run();
  setInterval(run, RECONCILE_INTERVAL_MS).unref();
}
