import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { ERR } from "../errors.js";

export type SocialProvider = "google" | "github" | "linkedin" | "microsoft" | "apple";

const ALL_PROVIDERS: readonly SocialProvider[] = [
  "google",
  "github",
  "linkedin",
  "microsoft",
  "apple",
];

function globallyEnabledProviders(): SocialProvider[] {
  return ALL_PROVIDERS.filter(
    (p) => config.providers[p as keyof typeof config.providers]?.enabled ?? false,
  );
}

// GET /api/app-config?client_id=<slug>
// Public endpoint — no authentication required.
// Returns the registration policy and enabled social providers for a given app.
// When client_id is omitted, returns the global defaults.
export async function appConfigRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { client_id?: string } }>("/", async (req, reply) => {
    const globalProviders = globallyEnabledProviders();
    const clientId = req.query.client_id;

    if (!clientId) {
      return reply.send({
        allowRegister: true,
        enabledSocialProviders: globalProviders,
      });
    }

    const [app] = await db
      .select({
        allowRegister: applications.allowRegister,
        enabledSocialProviders: applications.enabledSocialProviders,
      })
      .from(applications)
      .where(eq(applications.slug, clientId))
      .limit(1);

    if (!app) throw ERR.APP_002();

    // null means the app inherits all globally active providers.
    // An explicit array is intersected with globally active providers so a
    // provider that is removed from .env cannot be forced on by the DB.
    const enabledSocialProviders =
      app.enabledSocialProviders === null
        ? globalProviders
        : (app.enabledSocialProviders as SocialProvider[]).filter((p) =>
            globalProviders.includes(p),
          );

    return reply.send({
      allowRegister: app.allowRegister,
      enabledSocialProviders,
    });
  });
}
