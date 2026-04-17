---
seo:
  title: Auth Service — Self-hosted OAuth 2.1 / OIDC identity provider
  description: Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth. Multi-app RBAC, MFA (TOTP + passkeys), subscription plans with feature flags, and consumption tracking.
---

:::u-page-hero
#title
Auth Service

#description
A self-hosted OAuth 2.1 / OIDC identity provider built on [BetterAuth](https://better-auth.com). Issue tokens for any number of applications, enforce per-app RBAC, manage subscription plans, and track resource consumption — all from a single service.

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
What it does

#features
::::u-page-feature{icon="i-lucide-shield-check" title="OAuth 2.1 / OIDC compliant" description="Full authorization code flow with PKCE, client credentials, token introspection, JWKS, and standard discovery endpoints — compatible with any conformant client library."}
::::

::::u-page-feature{icon="i-lucide-layers" title="Multi-application RBAC" description="Each registered application gets its own isolated role and permission model. Users carry different roles across applications; claims are injected into JWT access tokens automatically."}
::::

::::u-page-feature{icon="i-lucide-fingerprint" title="MFA — TOTP and Passkeys" description="Two-factor authentication via TOTP (authenticator apps) and FIDO2 passkeys (YubiKey, Touch ID, Windows Hello). Per-application MFA enforcement is configurable."}
::::

::::u-page-feature{icon="i-lucide-credit-card" title="Subscription plans" description="Define subscription plans with arbitrary feature flags per application. Stripe integration creates products and prices automatically. Plan and feature data are included in access tokens."}
::::

::::u-page-feature{icon="i-lucide-bar-chart-2" title="Consumption tracking" description="Record arbitrary numeric counters (API calls, storage used, credits spent) against any user/application pair. Raw entries and running aggregates are stored in PostgreSQL."}
::::

::::u-page-feature{icon="i-lucide-building-2" title="Organization support" description="Multi-tenant organizations with owner / admin / member roles. The org_id claim is injected into access tokens for the org scope, enabling backend services to scope data by tenant."}
::::
:::
