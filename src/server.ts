import Fastify, { type FastifyInstance } from "fastify";
import { buildAliasTable, resolveAlias } from "./compat/aliases.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { prettyTransport } from "./logger.js";
import { healthRoutes } from "./routes/health.js";
import { applicationRoutes } from "./routes/admin/applications.js";
import { rolesRoutes } from "./routes/admin/roles.js";
import { plansRoutes } from "./routes/admin/plans.js";
import { planPricesRoutes } from "./routes/admin/plan-prices.js";
import { adminConsumptionRoutes } from "./routes/admin/adminConsumption.js";
import { usersRoutes } from "./routes/admin/users.js";
import { sessionsRoutes } from "./routes/admin/sessions.js";
import { statsRoutes } from "./routes/admin/stats.js";
import { monitoringRoutes } from "./routes/admin/monitoring.js";
import { eventsRoutes } from "./routes/events.js";
import { servicesRoutes } from "./routes/admin/services.js";
import { consumptionRoutes } from "./routes/consumption.js";
import { userRoutes } from "./routes/user.js";
import { userOrganizationRoutes } from "./routes/user-organizations.js";
import { userResourceRoutes } from "./routes/user-resources.js";
import { appResourceRoutes } from "./routes/app-resources.js";
import { sshResourceRoutes } from "./routes/ssh.js";
import { gatewaySshRoutes } from "./routes/gateway-ssh.js";
import { walletRoutes } from "./routes/wallet.js";
import { walletInternalRoutes } from "./routes/wallet-internal.js";
import { gatewayInternalRoutes } from "./routes/gateway-internal.js";
import { gatewayResourceRoutes } from "./routes/gateway-resources.js";
import { appBillingRoutes } from "./routes/app-billing.js";
import { appConsumptionRoutes } from "./routes/app-consumption.js";
import { billingPageRoutes } from "./routes/billing-pages.js";
import { subscriptionBillingRoutes } from "./routes/admin/subscription-billing.js";
import { adminWalletRoutes } from "./routes/admin/wallets.js";
import { accountingRoutes } from "./routes/admin/accounting.js";
import { applicationMachineScopesRoutes } from "./routes/admin/application-machine-scopes.js";
import { applicationFaviconRoutes } from "./routes/admin/application-favicon.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { organizationsRoutes } from "./routes/admin/organizations.js";
import { registrationInvitationRoutes } from "./routes/admin/registration-invitations.js";
import { registrationRoutes } from "./routes/registration.js";
import { invitationPagesRoutes } from "./routes/invitation-pages.js";
import { appConfigRoutes } from "./routes/app-config.js";
import { globalErrorHandler } from "./error-handler.js";
import { createRateLimitStore } from "./services/rate-limit-store.js";
import { createEventBus, setEventBus } from "./services/event-bus.js";
import { startPresenceWatcher } from "./services/presence.js";
import { registerDiscoveryRoutes } from "./server/discovery-routes.js";
import { registerEdgePlugins } from "./server/edge-plugins.js";
import { registerAuthRequestHook } from "./server/auth-request-hook.js";
import { PRESENCE_INTERVAL_MS } from "./server/rate-limit-policy.js";
import { registerAuthPages } from "./server/auth-pages.js";
import {
  createSpaFallback,
  registerSpaNotFound,
  registerStaticFrontend,
} from "./server/spa.js";
import { registerSessionManagementRoutes } from "./server/session-management-routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BuildServerOptions {
  /** Directory of the built SPA. Defaults to the one shipped next to the service. */
  frontendDist?: string;
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const aliasTable = buildAliasTable(config.compat.aliases);
  const fastify = Fastify({
    // Route aliases of another identity provider are resolved here, before
    // routing and before any hook, so every guard sees the canonical path.
    ...(aliasTable.size > 0
      ? {
          rewriteUrl: (req: { url?: string }) =>
            resolveAlias(req.url, aliasTable) ?? req.url ?? "",
        }
      : {}),
    // Trust only the configured reverse proxies so `req.ip` reflects the real
    // client address from `X-Forwarded-For` instead of the proxy's address —
    // and, crucially, so a client-forged `X-Forwarded-For` cannot move the
    // rate-limit bucket.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    logger: {
      level: config.isDev ? "debug" : "info",
      transport: prettyTransport(),
      serializers: {
        // Never log the query string: it can carry password-reset,
        // email-verification and magic-link tokens.
        req(req: { method?: string; url?: string }) {
          return {
            method: req.method,
            url: (req.url ?? "").split("?")[0],
          };
        },
      },
    },
  });

  await registerEdgePlugins(fastify);

  // ── Strict rate buckets for sensitive auth + email endpoints ────
  // Backed by an in-process counter by default; when REDIS_URL is set the
  // store is shared across instances (see services/rate-limit-store.ts).
  const rateLimitStore = await createRateLimitStore(config.redis.url);
  fastify.addHook("onClose", async () => {
    await rateLimitStore.close();
  });

  // ── Real-time event bus ─────────────────────────────────────────
  // In-process by default; when REDIS_URL is set the same optional-Redis
  // pattern as the rate-limit store fans events out across instances. The bus
  // is installed process-wide so write paths can publish without importing
  // this module.
  const eventBus = await createEventBus(config.redis.url);
  setEventBus(eventBus);
  const stopPresence = startPresenceWatcher(PRESENCE_INTERVAL_MS);
  fastify.addHook("onClose", async () => {
    stopPresence();
    await eventBus.close();
    setEventBus(null);
  });

  // ── Static frontend (built Vue SPA) ─────────────────────────────
  const frontendDist =
    options.frontendDist ?? join(__dirname, "..", "frontend-dist");

  const sendSpaFallback = createSpaFallback(fastify, frontendDist);
  await registerStaticFrontend(fastify, frontendDist);

  registerAuthPages(fastify, { frontendDist, sendSpaFallback });

  registerAuthRequestHook(fastify, rateLimitStore);

  // ── Global error handler ────────────────────────────────────────
  // Registered before the routes: a handler set after a plugin has been
  // registered is not inherited by it, and thrown ApiError / ZodError would
  // fall back to Fastify's default serialisation.
  fastify.setErrorHandler(globalErrorHandler);

  // ── Routes ──────────────────────────────────────────────────────
  // Stripe webhook first — its raw Buffer parser must take precedence.
  await fastify.register(stripeWebhookRoutes, {
    prefix: "/api/webhooks/stripe",
  });
  await fastify.register(healthRoutes);
  await fastify.register(applicationRoutes, {
    prefix: "/api/admin/applications",
  });
  await fastify.register(subscriptionBillingRoutes, {
    prefix: "/api/admin/applications",
  });
  await fastify.register(applicationMachineScopesRoutes, {
    prefix: "/api/admin/applications",
  });
  await fastify.register(applicationFaviconRoutes, {
    prefix: "/api/admin/applications",
  });
  await fastify.register(rolesRoutes, { prefix: "/api/admin" });
  await fastify.register(plansRoutes, { prefix: "/api/admin" });
  await fastify.register(planPricesRoutes, { prefix: "/api/admin" });
  await fastify.register(adminConsumptionRoutes, { prefix: "/api/admin" });
  await fastify.register(usersRoutes, { prefix: "/api/admin/users" });
  await fastify.register(sessionsRoutes, { prefix: "/api/admin/sessions" });
  await fastify.register(statsRoutes, { prefix: "/api/admin/stats" });
  await fastify.register(monitoringRoutes, { prefix: "/api/admin/monitoring" });
  await fastify.register(eventsRoutes, { prefix: "/api/events" });
  await fastify.register(servicesRoutes, { prefix: "/api/admin/services" });
  await fastify.register(organizationsRoutes, {
    prefix: "/api/admin/organizations",
  });
  await fastify.register(registrationInvitationRoutes, {
    prefix: "/api/admin/registration-invitations",
  });
  await fastify.register(invitationPagesRoutes);
  await fastify.register(registrationRoutes, { prefix: "/api/registration" });
  await fastify.register(consumptionRoutes, { prefix: "/api/consumption" });
  await fastify.register(userRoutes, { prefix: "/api/user" });
  await fastify.register(userOrganizationRoutes, {
    prefix: "/api/user/organizations",
  });
  if (config.features.resourceSharing) {
    await fastify.register(userResourceRoutes, { prefix: "/api/user" });
    await fastify.register(appResourceRoutes, { prefix: "/api/user" });
    if (config.resources.enabledSchemes.includes("ssh")) {
      await fastify.register(sshResourceRoutes, { prefix: "/api/user" });
    }
  }
  await fastify.register(walletRoutes, { prefix: "/api/user/wallet" });
  await fastify.register(walletInternalRoutes, {
    prefix: "/api/internal/wallet",
  });
  await fastify.register(gatewayInternalRoutes, {
    prefix: "/api/internal/gateway",
  });
  if (config.features.resourceSharing) {
    await fastify.register(gatewayResourceRoutes, {
      prefix: "/api/internal/gateway",
    });
    if (config.resources.enabledSchemes.includes("ssh")) {
      await fastify.register(gatewaySshRoutes, {
        prefix: "/api/internal/gateway",
      });
    }
  }
  await fastify.register(appBillingRoutes, { prefix: "/api/app/billing" });
  await fastify.register(appConsumptionRoutes, {
    prefix: "/api/app/consumption",
  });
  await fastify.register(billingPageRoutes);
  await fastify.register(adminWalletRoutes, { prefix: "/api/admin/wallets" });
  await fastify.register(accountingRoutes, {
    prefix: "/api/admin/accounting",
  });
  await fastify.register(appConfigRoutes, { prefix: "/api/app-config" });

  registerDiscoveryRoutes(fastify);
  registerSessionManagementRoutes(fastify);
  registerSpaNotFound(fastify, frontendDist);

  return fastify;
}
