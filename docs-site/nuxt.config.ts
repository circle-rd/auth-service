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
      "Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth. Multi-app RBAC, MFA, subscription plans, and consumption tracking.",
    full: {
      title: "Auth Service — Complete Documentation",
      description:
        "Complete documentation for auth-service, a self-hosted OAuth 2.1 / OIDC identity provider. Covers deployment, configuration, application management, RBAC, subscription plans, organization support, consumption tracking, and the full REST API reference.",
    },
  },
});
