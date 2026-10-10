import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { oauthClient } from "../../db/auth-schema.js";
import { applications } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import { getCallerRole, requireAdmin } from "../../middleware.js";
import { MACHINE_SCOPES } from "../../services/machine-auth.js";
import { revokeClientTokens } from "../../services/oauth-tokens.js";
import { publishEvent } from "../../services/event-bus.js";

const idParamsSchema = z.object({ id: z.string().uuid() });

const machineScopesSchema = z.object({
  scopes: z
    .array(z.enum(MACHINE_SCOPES))
    .transform((scopes) => [...new Set(scopes)]),
});

async function findPrivateApplication(id: string) {
  const [app] = await db
    .select({
      slug: applications.slug,
      isPublic: applications.isPublic,
      scopes: oauthClient.clientCredentialsScopes,
    })
    .from(applications)
    .innerJoin(oauthClient, eq(oauthClient.clientId, applications.slug))
    .where(eq(applications.id, id))
    .limit(1);
  if (!app) throw ERR.APP_002();
  return app;
}

/**
 * Scopes an application may request through the `client_credentials` grant.
 * Kept apart from the application CRUD: they grant machine privileges (such as
 * debiting any user's wallet), so changing them is superadmin-only.
 */
export async function applicationMachineScopesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/applications/:id/machine-scopes
  fastify.get("/:id/machine-scopes", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const app = await findPrivateApplication(id);
    await reply.send({ scopes: app.scopes ?? [] });
  });

  // PUT /api/admin/applications/:id/machine-scopes
  fastify.put("/:id/machine-scopes", async (req, reply) => {
    if ((await getCallerRole(req)) !== "superadmin") {
      throw ERR.AUTH_011("Only superadmins can change machine scopes");
    }
    const { id } = idParamsSchema.parse(req.params);
    const { scopes } = machineScopesSchema.parse(req.body);
    const app = await findPrivateApplication(id);
    if (app.isPublic) {
      throw ERR.APP_001(
        "Public clients cannot use the client_credentials grant",
      );
    }

    await db
      .update(oauthClient)
      .set({ clientCredentialsScopes: scopes })
      .where(eq(oauthClient.clientId, app.slug));

    // A narrowed scope set must not survive in tokens already issued.
    const removed = (app.scopes ?? []).some(
      (s) => !scopes.includes(s as never),
    );
    if (removed) await revokeClientTokens(app.slug);

    publishEvent("application.changed");
    await reply.send({ scopes });
  });
}
