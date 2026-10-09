/**
 * Unit test — the root OIDC / OAuth 2.0 discovery endpoints must be readable by
 * a browser on a registered application's origin.
 *
 * The documented client integration (the PKCE login flow of a client app) runs
 * `oauth4webapi`'s `discoveryRequest()` in the browser before the user signs
 * in, so the response is consumed as a CORS-mode fetch from the application
 * origin. Three things therefore have to hold on both discovery routes, and all
 * are asserted here:
 *
 *  1. `access-control-allow-origin` is present on the response — without it the
 *     browser reports `blocked by CORS policy: No 'Access-Control-Allow-Origin'
 *     header is present` and the fetch rejects.
 *  2. `Cross-Origin-Resource-Policy: same-origin`, which `@fastify/helmet`
 *     stamps on every response, is dropped on this route. CORP is enforced
 *     through the embedder-policy check, which the Fetch standard applies to
 *     opaque (no-cors) loads; leaving it in place contradicts the CORS header
 *     the route now sends.
 *  3. The preflight is answered — the catch-all `OPTIONS *` route installed by
 *     `@fastify/cors` answers 404 for an origin outside `CORS_ORIGINS`, which
 *     fails the preflight before the real request is ever sent.
 *
 * `server.ts` imports the whole route graph, so the database handle, the mail
 * service and the route modules are stubbed: only the route registration and
 * the CORS/CORP behaviour configured in `server.ts` are under test here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type * as OauthProviderModule from "@better-auth/oauth-provider";

function notFoundRoutes(): Record<string, unknown> {
  const noop = async () => undefined;
  return {
    healthRoutes: noop,
    applicationRoutes: noop,
    rolesRoutes: noop,
    plansRoutes: noop,
    adminConsumptionRoutes: noop,
    usersRoutes: noop,
    sessionsRoutes: noop,
    statsRoutes: noop,
    eventsRoutes: noop,
    servicesRoutes: noop,
    consumptionRoutes: noop,
    userRoutes: noop,
    stripeWebhookRoutes: noop,
    organizationsRoutes: noop,
    appConfigRoutes: noop,
  };
}

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/mail/index.js", () => ({
  getMailTransport: () => ({ name: "noop", verify: undefined }),
  isMailConfigured: () => false,
  setMailTransport: () => undefined,
}));
vi.mock("../services/templates.js", () => ({ renderAuthPage: () => "" }));
vi.mock("../services/rate-limit-store.js", () => ({
  createRateLimitStore: async () => ({
    hit: async () => true,
    close: async () => undefined,
  }),
}));
vi.mock("../routes/health.js", () => ({
  healthRoutes: notFoundRoutes().healthRoutes,
}));
vi.mock("../routes/admin/applications.js", () => ({
  applicationRoutes: notFoundRoutes().applicationRoutes,
}));
vi.mock("../routes/admin/roles.js", () => ({
  rolesRoutes: notFoundRoutes().rolesRoutes,
}));
vi.mock("../routes/admin/plans.js", () => ({
  plansRoutes: notFoundRoutes().plansRoutes,
}));
vi.mock("../routes/admin/adminConsumption.js", () => ({
  adminConsumptionRoutes: notFoundRoutes().adminConsumptionRoutes,
}));
vi.mock("../routes/admin/users.js", () => ({
  usersRoutes: notFoundRoutes().usersRoutes,
}));
vi.mock("../routes/admin/sessions.js", () => ({
  sessionsRoutes: notFoundRoutes().sessionsRoutes,
}));
vi.mock("../routes/admin/stats.js", () => ({
  statsRoutes: notFoundRoutes().statsRoutes,
}));
vi.mock("../routes/admin/events.js", () => ({
  eventsRoutes: notFoundRoutes().eventsRoutes,
}));
vi.mock("../services/event-bus.js", () => ({
  createEventBus: async () => ({
    publish: () => undefined,
    subscribe: () => () => undefined,
    close: async () => undefined,
    subscriberCount: 0,
    name: "memory",
  }),
  setEventBus: () => undefined,
}));
vi.mock("../routes/admin/services.js", () => ({
  servicesRoutes: notFoundRoutes().servicesRoutes,
}));
vi.mock("../routes/admin/organizations.js", () => ({
  organizationsRoutes: notFoundRoutes().organizationsRoutes,
}));
vi.mock("../routes/consumption.js", () => ({
  consumptionRoutes: notFoundRoutes().consumptionRoutes,
}));
vi.mock("../routes/user.js", () => ({
  userRoutes: notFoundRoutes().userRoutes,
}));
vi.mock("../routes/stripe-webhook.js", () => ({
  stripeWebhookRoutes: notFoundRoutes().stripeWebhookRoutes,
}));
vi.mock("../routes/app-config.js", () => ({
  appConfigRoutes: notFoundRoutes().appConfigRoutes,
  globallyEnabledProviders: () => [],
}));
vi.mock("./auth.js", () => ({
  auth: { api: {}, handler: async () => new Response(null, { status: 404 }) },
}));
// Partial mock: `auth.ts` still needs the real `oauthProvider` plugin factory,
// while the two metadata handlers are replaced by stubs whose response body
// this test can assert on without a live BetterAuth instance.
vi.mock("@better-auth/oauth-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof OauthProviderModule>();
  const metadataHandler = async () =>
    Response.json({ issuer: "http://localhost:3001" });
  return {
    ...actual,
    oauthProviderOpenIdConfigMetadata: () => metadataHandler,
    oauthProviderAuthServerMetadata: () => metadataHandler,
  };
});

const { buildServer } = await import("./server.js");

const APPLICATION_ORIGIN = "https://app.example.com";
const DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
];

describe("OIDC discovery CORS", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  for (const path of DISCOVERY_PATHS) {
    it(`GET ${path} allows the application origin to read the document`, async () => {
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: { origin: APPLICATION_ORIGIN },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      // Public metadata: never negotiated with credentials, and never
      // advertised as such.
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(res.json()).toMatchObject({ issuer: expect.any(String) });
    });

    it(`GET ${path} does not restrict embedding via Cross-Origin-Resource-Policy`, async () => {
      const res = await app.inject({
        method: "GET",
        url: path,
        headers: { origin: APPLICATION_ORIGIN },
      });

      // helmet stamps `Cross-Origin-Resource-Policy: same-origin` on every
      // response; the CORP embedder-policy check also applies to opaque
      // (no-cors) loads, so the discovery document must not carry it.
      expect(res.headers["cross-origin-resource-policy"]).toBeUndefined();
    });

    it(`OPTIONS ${path} answers the preflight instead of 404`, async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: path,
        headers: {
          origin: APPLICATION_ORIGIN,
          "access-control-request-method": "GET",
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
    });
  }

  it("does not widen CORS for non-discovery routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/app-config",
      headers: { origin: APPLICATION_ORIGIN },
    });

    // The application origin is not a dashboard origin (CORS_ORIGINS), so the
    // CORS plugin must not echo it — and must not fall back to `*` either.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
