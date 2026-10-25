import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { requireAdmin } from "../../middleware.js";

export async function servicesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  /**
   * GET /api/admin/services
   * Returns whether optional integrations are configured via environment variables.
   * Only accessible to admin and superadmin users.
   *
   * Provider credentials are intentionally never serialised in full: only the
   * non-secret client id is exposed so the UI can confirm configuration. The
   * `clientSecret` never leaves the server.
   */
  fastify.get("/", async (_req, reply) => {
    const { compat } = config;
    await reply.send({
      stripe: !!config.stripe.secretKey,
      compat: {
        profile: compat.profile,
        tokenAuthMethod: compat.tokenAuthMethod,
        signingAlg: compat.signingAlg,
        defaultAudience: compat.defaultAudience,
        audienceParam: compat.audienceParam,
        claimMappings: compat.claimMappings,
        aliases: compat.aliases,
      },
      providers: {
        google: {
          enabled: config.providers.google.enabled,
          clientId: config.providers.google.clientId,
        },
        github: {
          enabled: config.providers.github.enabled,
          clientId: config.providers.github.clientId,
        },
        linkedin: {
          enabled: config.providers.linkedin.enabled,
          clientId: config.providers.linkedin.clientId,
        },
        microsoft: {
          enabled: config.providers.microsoft.enabled,
          clientId: config.providers.microsoft.clientId,
        },
        apple: {
          enabled: config.providers.apple.enabled,
          clientId: config.providers.apple.clientId,
        },
      },
    });
  });
}
