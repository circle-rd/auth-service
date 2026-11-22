import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { oauthClient } from "../../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { randomBytes } from "node:crypto";
import { revokeClientTokens } from "../../services/oauth-tokens.js";
import { ADMIN_ROOM, publishEvent } from "../../services/event-bus.js";
import { hashClientSecret } from "./application-oauth-client.js";

export // Only providers the service actually registers with BetterAuth can be
// assigned; a button for an unwired provider would fail at sign-in.
const socialProviderSchema = z.enum(["google", "github"]);

export async function applicationCredentialRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // POST /api/admin/applications/:id/rotate-secret
  fastify.post<{ Params: { id: string } }>(
    "/:id/rotate-secret",
    async (req, reply) => {
      const [app] = await db
        .select({
          id: applications.id,
          slug: applications.slug,
          isPublic: applications.isPublic,
        })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      if (app.isPublic) {
        throw ERR.APP_001("Public clients do not have a client secret");
      }

      const newSecret = randomBytes(32).toString("hex");
      const hashedSecret = hashClientSecret(newSecret);

      await db
        .update(oauthClient)
        .set({ clientSecret: hashedSecret })
        .where(eq(oauthClient.clientId, app.slug));

      // Invalidate every token minted with the previous secret.
      await revokeClientTokens(app.slug);

      await reply.send({ clientSecret: newSecret });
    },
  );

  // PATCH /api/admin/applications/:id/providers — update per-app social providers
  const updateProvidersSchema = z.object({
    enabledSocialProviders: z.array(socialProviderSchema).nullable(),
  });

  fastify.patch<{ Params: { id: string } }>(
    "/:id/providers",
    async (req, reply) => {
      const parsed = updateProvidersSchema.safeParse(req.body);
      if (!parsed.success) {
        throw ERR.APP_001("Invalid providers data");
      }

      const [app] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.id, req.params.id))
        .limit(1);
      if (!app) throw ERR.APP_002();

      const [updated] = await db
        .update(applications)
        .set({ enabledSocialProviders: parsed.data.enabledSocialProviders })
        .where(eq(applications.id, req.params.id))
        .returning();

      publishEvent("application.changed", [ADMIN_ROOM]);

      await reply.send({ application: updated });
    },
  );
}
