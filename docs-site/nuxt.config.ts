export default defineNuxtConfig({
  extends: ["docus"],
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL ?? "/auth-service/",
  },
  site: {
    url: process.env.NUXT_SITE_URL ?? "https://docs.circle-cyber.com/auth-service",
  },
  llms: {
    title: "Auth Service",
    description:
      "Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth — multi-app RBAC, MFA, passkeys, and subscription management.",
    full: {
      title: "Auth Service — Complete Documentation",
      description:
        "Complete documentation for Auth Service, a self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth v1.5. Covers installation, configuration, application management, per-app RBAC, subscription plans, consumption tracking, Stripe billing integration, and the full REST API reference.",
    },
  },
});
