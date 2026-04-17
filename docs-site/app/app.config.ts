export default defineAppConfig({
  seo: {
    title: "Auth Service",
    description:
      "Self-hosted OAuth 2.1 / OIDC identity provider. Multi-app RBAC, MFA (TOTP + passkeys), subscription plans with feature flags, and consumption tracking.",
  },
  header: {
    title: "Auth Service",
  },
  socials: {
    github: "https://github.com/circle-rd/auth-service",
  },
  github: {
    url: "https://github.com/circle-rd/auth-service",
    branch: "main",
    rootDir: "docs-site",
  },
});
