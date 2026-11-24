import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import {
  archiveApplicationCatalogue,
  loadApplicationCatalogue,
} from "../../services/billing/catalog.js";
import { oauthClient } from "../../db/auth-schema.js";
import { eq } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { removeCorsOrigin } from "../../runtime-config.js";
import { deleteClientResource } from "../../services/oauth-resources.js";
import { requireAdmin } from "../../middleware.js";
import { ADMIN_ROOM, publishEvent } from "../../services/event-bus.js";
import { applicationBillingRoutes } from "./application-billing.js";
import { applicationCreateRoutes } from "./application-create.js";
import { applicationCredentialRoutes } from "./application-credentials.js";
import { withResourceWebhookSecret } from "./application-fields.js";
import {
  fetchOauthClientView,
  fetchOauthClientViews,
  mergeOauthView,
  toOauthClientView,
} from "./application-oauth-client.js";
import { deleteGrantsNamingSubject } from "../../services/resources/resource-deletion.js";
import { applicationUpdateRoutes } from "./application-update.js";
import { applicationUserRoutes } from "./application-users.js";

export async function applicationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);
  // GET /api/admin/applications
  fastify.get("/", async (_req, reply) => {
    const rows = await db
      .select()
      .from(applications)
      .orderBy(applications.createdAt);
    const views = await fetchOauthClientViews(rows.map((r) => r.slug));
    const enriched = rows.map((r) =>
      withResourceWebhookSecret(
        mergeOauthView(r, views.get(r.slug) ?? toOauthClientView(undefined)),
      ),
    );
    await reply.send({ applications: enriched });
  });
  // GET /api/admin/applications/:id
  fastify.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!app) throw ERR.APP_002();
    const view = await fetchOauthClientView(app.slug);
    await reply.send({
      application: withResourceWebhookSecret(mergeOauthView(app, view)),
    });
  });
  // DELETE /api/admin/applications/:id
  // All related rows (roles, plans, user_applications, etc.) are cascade-deleted via FK constraints.
  fastify.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const [existing] = await db
      .select({
        isSystem: applications.isSystem,
      })
      .from(applications)
      .where(eq(applications.id, req.params.id))
      .limit(1);
    if (!existing) throw ERR.APP_002();
    if (existing.isSystem) throw ERR.APP_007();

    // Read the catalogue before the application's rows cascade away, so its
    // Stripe objects can be archived (never deleted) afterwards.
    const catalogue = await loadApplicationCatalogue(req.params.id);

    // Application grants name the slug, with no foreign key: delete them with
    // the application so none is left pointing at a name that could be reused.
    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(applications)
        .where(eq(applications.id, req.params.id))
        .returning({
          id: applications.id,
          slug: applications.slug,
          url: applications.url,
        });
      if (row) await deleteGrantsNamingSubject("application", row.slug, tx);
      return row;
    });
    if (!deleted) throw ERR.APP_002();

    // Remove the oauthClient row (cascades to tokens/consents in BetterAuth tables)
    await db.delete(oauthClient).where(eq(oauthClient.clientId, deleted.slug));

    // Drop the client's protected-resource links.
    await deleteClientResource(deleted.slug);

    // Remove the URL from runtime-config.
    if (deleted.url) {
      removeCorsOrigin(deleted.url);
    }

    await archiveApplicationCatalogue(catalogue);

    publishEvent("application.changed", [ADMIN_ROOM]);

    await reply.status(204).send();
  });
  await fastify.register(applicationCreateRoutes);
  await fastify.register(applicationUpdateRoutes);
  await fastify.register(applicationUserRoutes);
  await fastify.register(applicationBillingRoutes);
  await fastify.register(applicationCredentialRoutes);
}
