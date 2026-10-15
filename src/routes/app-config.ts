import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { ERR } from "../errors.js";
import { isMailConfigured } from "../services/mail/index.js";

export type SocialProvider =
  "google" | "github" | "linkedin" | "microsoft" | "apple";

const ALL_PROVIDERS: readonly SocialProvider[] = [
  "google",
  "github",
  "linkedin",
  "microsoft",
  "apple",
];

export function globallyEnabledProviders(): SocialProvider[] {
  return ALL_PROVIDERS.filter(
    (p) =>
      config.providers[p as keyof typeof config.providers]?.enabled ?? false,
  );
}

/**
 * Social providers an application's sign-in page offers: the globally enabled
 * ones, narrowed by the application's own allow-list.
 *
 * `null` means the application inherits every globally enabled provider. An
 * explicit array is intersected with them, so a provider removed from the
 * environment cannot be forced on by the database.
 */
export function socialProvidersFor(
  enabledSocialProviders: string[] | null,
): SocialProvider[] {
  const global = globallyEnabledProviders();
  if (enabledSocialProviders === null) return global;
  return global.filter((p) => enabledSocialProviders.includes(p));
}

// GET /api/app-config?client_id=<slug>
// Public endpoint — no authentication required.
// Returns the registration policy and enabled social providers for a given app.
// When client_id is omitted, returns the global defaults.
export async function appConfigRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { client_id?: string } }>(
    "/",
    async (req, reply) => {
      const clientId = req.query.client_id;
      // The admin UI only offers "resend / mark verified" actions when the
      // deployment can actually deliver mail and verification is enforced.
      const emailVerificationEnabled =
        isMailConfigured() && config.email.requireVerification;

      if (!clientId) {
        return reply.send({
          // The service's own sign-in (administration interface) never offers
          // social providers: registration is not open on it, accounts come
          // from the applications that allow it.
          allowRegister: false,
          enabledSocialProviders: [],
          appName: config.appName,
          logoUrl: config.appLogoUrl ?? null,
          logoDarkUrl: config.appLogoDarkUrl ?? null,
          emailVerificationEnabled,
          showcase: config.showcase,
        });
      }

      const [app] = await db
        .select({
          allowRegister: applications.allowRegister,
          enabledSocialProviders: applications.enabledSocialProviders,
          name: applications.name,
          icon: applications.icon,
        })
        .from(applications)
        .where(eq(applications.slug, clientId))
        .limit(1);

      if (!app) throw ERR.APP_002();

      return reply.send({
        allowRegister: app.allowRegister,
        enabledSocialProviders: socialProvidersFor(app.enabledSocialProviders),
        name: app.name,
        icon: app.icon ?? null,
        appName: config.appName,
        logoUrl: config.appLogoUrl ?? null,
        logoDarkUrl: config.appLogoDarkUrl ?? null,
        emailVerificationEnabled,
        showcase: config.showcase,
      });
    },
  );
}
