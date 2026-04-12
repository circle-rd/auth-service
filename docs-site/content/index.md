---
seo:
  title: Auth Service
  description: Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth — multi-app RBAC, MFA, passkeys, and subscription management.
---

:::u-page-hero
#title
Auth Service

#description
Self-hosted OAuth 2.1 / OIDC identity provider built on [BetterAuth](https://better-auth.com) v1.5. Email/password auth, MFA (TOTP + passkeys), multi-app RBAC, subscription plans with feature flags, consumption tracking, and an embedded Vue 3 admin SPA.

#links
::::u-button{to="/docs/getting-started/introduction" size="xl" trailing-icon="i-lucide-arrow-right" color="neutral"}
Get started
::::

::::u-button{to="https://github.com/circle-rd/auth-service" target="_blank" size="xl" variant="outline" color="neutral" icon="i-simple-icons-github"}
GitHub
::::
:::

:::u-page-section
#title
Key features

#features
::::u-page-feature{icon="i-lucide-lock" title="OAuth 2.1 / OIDC" description="Full Authorization Code + PKCE flow, refresh tokens, JWKS endpoint, and OpenID Connect discovery document at the issuer root."}
::::

::::u-page-feature{icon="i-lucide-shield-check" title="Multi-factor authentication" description="TOTP (two-factor) and WebAuthn passkey / YubiKey registration and authentication via BetterAuth plugins."}
::::

::::u-page-feature{icon="i-lucide-users" title="Multi-app RBAC" description="Each registered application has its own roles and permissions injected into the id_token as custom claims — no shared role namespace."}
::::

::::u-page-feature{icon="i-lucide-layers" title="Subscription plans" description="Per-application subscription plans with JSON feature flags. Stripe billing integration synchronises plan status via webhooks."}
::::

::::u-page-feature{icon="i-lucide-bar-chart-2" title="Consumption tracking" description="Record arbitrary numeric metrics (API calls, storage, seats…) per user per application. Aggregate queries and admin reset built-in."}
::::

::::u-page-feature{icon="i-lucide-layout-dashboard" title="Admin SPA" description="Embedded Vue 3 admin dashboard for managing applications, users, roles, plans, and sessions — served directly by the backend."}
::::
:::
