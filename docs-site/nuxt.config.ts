export default defineNuxtConfig({
  extends: ["docus"],
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL ?? "/auth-service/",
  },
  site: {
    url: process.env.NUXT_SITE_URL ?? "https://docs.circle-cyber.com/auth-service",
  },
  robots: { robotsTxt: false },
  image: {
    provider: "passthrough",
    providers: {
      passthrough: { name: "passthrough", provider: "~/providers/passthrough" },
    },
  },
  meta: {
    title: "Auth Service",
    description:
      "Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth. Multi-app RBAC, MFA, subscription plans, and consumption tracking.",
    ogHost: process.env.NUXT_SITE_URL ?? "https://docs.circle-cyber.com/auth-service",
  },
  llms: {
    title: "Auth Service",
    description:
      "Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth. Multi-app RBAC, MFA, subscription plans, and consumption tracking.",
    full: {
      title: "Auth Service — Complete Documentation",
      description:
        "Complete documentation for auth-service, a self-hosted OAuth 2.1 / OIDC identity provider. Covers deployment, configuration, application management, RBAC, subscription plans, the credit wallet and LiteLLM gateway, integration guides, and the client SDKs.",
    },
    sections: [
      {
        title: "Client SDKs",
        description: "Official SDKs for applications that sign users in through auth-service.",
        links: [
          {
            title: "CIRCLE auth-ai (TypeScript) documentation",
            description:
              "@circle-rd/auth-ai: Fastify and Web-standard handlers, React and Vue bindings, wallet, gateway, billing and consumption.",
            href: "https://docs.circle-cyber.com/auth-ai/typescript/",
          },
          {
            title: "CIRCLE auth-ai (Python) documentation",
            description:
              "auth-ai on PyPI: FastAPI and Starlette adapters, same behaviours and wire contract as the TypeScript SDK.",
            href: "https://docs.circle-cyber.com/auth-ai/python/",
          },
        ],
      },
    ],
  },
});
