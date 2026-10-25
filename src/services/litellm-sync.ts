/**
 * Keeps one gateway team per application with LiteLLM support.
 *
 * An application has the support when the URL of the `litellm` application (the
 * gateway, a protected resource) is in its `allowedResources`: that is what lets
 * it obtain tokens the gateway accepts, and what the "LiteLLM support" switch of
 * the admin form sets. The team is what lets a gateway administrator give that
 * application its own models, MCP servers, budget and limits in LiteLLM.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { config } from "../config.js";
import { ERR } from "../errors.js";
import { logger } from "../logger.js";
import {
  LitellmGatewayError,
  blockTeam,
  deleteTeam,
  ensureTeam,
  isGatewayConfigured,
  listTeams,
} from "./litellm-teams.js";
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

/**
 * Before an application is saved with LiteLLM support it did not have: its team
 * must exist, otherwise the application would get tokens the gateway then refuses.
 * `previousResources` is what it could request before the save (`[]` for a new
 * one). Throws `SRV_004` and nothing is saved when the gateway cannot do it.
 */
export async function ensureTeamBeforeSave(
  app: AppLike,
  previousResources: string[],
): Promise<void> {
  const gateway = await active();
  if (
    !supportsLitellm(app.allowedResources, gateway) ||
    supportsLitellm(previousResources, gateway)
  ) {
    return;
  }
  try {
    await ensureTeam(app.slug, app.name);
  } catch (err) {
    if (err instanceof LitellmGatewayError) throw ERR.SRV_004(err.message);
    throw err;
  }
}

/**
 * After a save, or a deletion (`next` is null): cut the team of an application
 * that lost its support. The save already stopped new tokens, so a failure only
 * warns (the reconciler retries). A deleted application's team is deleted, an
 * edited one's is blocked.
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
    if (next === null) await deleteTeam(slug);
    else await blockTeam(slug);
  } catch (err) {
    logger.warn(
      { err: String(err), slug },
      "[litellm] could not retire the gateway team; the reconciler will retry",
    );
  }
}

export interface ReconcileReport {
  ensured: string[];
  blocked: string[];
  failed: string[];
}

/**
 * Bring the gateway teams in line with the applications: every application with
 * LiteLLM support has a usable team, and a team auth-service manages whose
 * application lost the support (or no longer exists) is blocked. Teams made by
 * hand in the gateway are left alone.
 */
export async function reconcileLitellmTeams(): Promise<ReconcileReport> {
  const report: ReconcileReport = { ensured: [], blocked: [], failed: [] };
  const gateway = await active();
  if (!gateway) return report;

  const apps = await db
    .select({
      slug: applications.slug,
      name: applications.name,
      allowedResources: applications.allowedResources,
      isSystem: applications.isSystem,
    })
    .from(applications);
  const supporting = new Set<string>();
  for (const app of apps) {
    if (app.isSystem || !supportsLitellm(app.allowedResources, gateway))
      continue;
    supporting.add(app.slug);
    try {
      await ensureTeam(app.slug, app.name);
      report.ensured.push(app.slug);
    } catch (err) {
      report.failed.push(app.slug);
      logger.warn(
        { err: String(err), slug: app.slug },
        "[litellm] team sync failed",
      );
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
    const managed = team.metadata?.managed_by === "auth-service";
    if (!managed || supporting.has(team.team_id) || team.blocked) continue;
    try {
      await blockTeam(team.team_id);
      report.blocked.push(team.team_id);
    } catch (err) {
      report.failed.push(team.team_id);
      logger.warn(
        { err: String(err), slug: team.team_id },
        "[litellm] team block failed",
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
