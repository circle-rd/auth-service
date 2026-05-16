import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../../db/index.js";
import { session as sessionTable } from "../../db/auth-schema.js";
import { applications, loginHistory } from "../../db/schema.js";
import { and, countDistinct, eq, gt, gte, sql } from "drizzle-orm";
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

const rangeSchema = z.enum(["7d", "30d"]).default("7d");
const loginsQuerySchema = z.object({
  range: rangeSchema.optional(),
  appId: z.string().uuid().optional(),
});

function rangeToDays(range: "7d" | "30d"): number {
  return range === "30d" ? 30 : 7;
}

/**
 * Build a dense [{ date, count }] series for the given range, filling missing
 * days with zero so chart libraries do not need to interpolate.
 */
function denseSeries(
  raw: { day: string; count: number }[],
  days: number,
): { date: string; count: number }[] {
  const byDay = new Map(raw.map((r) => [r.day, r.count]));
  const out: { date: string; count: number }[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/stats/active-users
  // Distinct users with at least one non-expired session — i.e. currently online.
  fastify.get("/active-users", async (_req, reply) => {
    const now = new Date();
    const [{ online }] = await db
      .select({ online: countDistinct(sessionTable.userId) })
      .from(sessionTable)
      .where(gt(sessionTable.expiresAt, now));
    await reply.send({ online });
  });

  // GET /api/admin/stats/logins?range=7d|30d&appId=<uuid>
  // Daily login counts (per-app or platform-wide). Dense series — zero-filled
  // for days with no logins so the frontend chart renders a continuous axis.
  fastify.get("/logins", async (req, reply) => {
    const parsed = loginsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw ERR.APP_001("Invalid stats query", parsed.error.flatten());
    }
    const range = parsed.data.range ?? "7d";
    const days = rangeToDays(range);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (days - 1));
    since.setUTCHours(0, 0, 0, 0);

    const conditions = [gte(loginHistory.loggedAt, since)];
    if (parsed.data.appId) {
      conditions.push(eq(loginHistory.applicationId, parsed.data.appId));
    }

    // Raw aggregate via sql`` because date_trunc is not exposed by the typed
    // builder; the input is server-controlled (no user concatenation).
    const rows = (await db.execute(
      sql`SELECT to_char(date_trunc('day', logged_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                 COUNT(*)::int AS count
          FROM login_history
          WHERE ${and(...conditions)}
          GROUP BY day
          ORDER BY day ASC`,
    )) as { day: string; count: number }[];

    const series = denseSeries(rows, days);
    const total = series.reduce((acc, r) => acc + r.count, 0);
    await reply.send({ range, series, total });
  });

  // GET /api/admin/stats/applications-activity
  // One bulk row per application: { appId, online (distinct users via this app
  // in active sessions ≈ logins in the last 24h), last7dLogins, sparkline[7] }.
  // Used by the applications grid to avoid N+1 calls for per-card stats.
  fastify.get("/applications-activity", async (_req, reply) => {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 6);
    since.setUTCHours(0, 0, 0, 0);

    const apps = await db
      .select({ id: applications.id })
      .from(applications);

    if (apps.length === 0) {
      await reply.send({ applications: [] });
      return;
    }

    const rows = (await db.execute(
      sql`SELECT application_id AS "appId",
                 to_char(date_trunc('day', logged_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                 COUNT(*)::int AS count
          FROM login_history
          WHERE application_id IS NOT NULL
            AND logged_at >= ${since}
          GROUP BY application_id, day`,
    )) as { appId: string; day: string; count: number }[];

    // Online proxy: distinct users with a login event in the last 24h per app.
    const online24h = new Date();
    online24h.setUTCHours(online24h.getUTCHours() - 24);
    const onlineRows = (await db.execute(
      sql`SELECT application_id AS "appId",
                 COUNT(DISTINCT user_id)::int AS online
          FROM login_history
          WHERE application_id IS NOT NULL
            AND logged_at >= ${online24h}
          GROUP BY application_id`,
    )) as { appId: string; online: number }[];
    const onlineByApp = new Map(onlineRows.map((r) => [r.appId, r.online]));

    const byApp = new Map<string, { day: string; count: number }[]>();
    for (const r of rows) {
      const arr = byApp.get(r.appId) ?? [];
      arr.push({ day: r.day, count: r.count });
      byApp.set(r.appId, arr);
    }

    const result = apps.map((a) => {
      const series = denseSeries(byApp.get(a.id) ?? [], 7);
      const last7dLogins = series.reduce((acc, p) => acc + p.count, 0);
      return {
        appId: a.id,
        online: onlineByApp.get(a.id) ?? 0,
        last7dLogins,
        sparkline: series,
      };
    });

    await reply.send({ applications: result });
  });
}
