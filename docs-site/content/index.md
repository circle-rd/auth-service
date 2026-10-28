---
seo:
  title: Auth Service — Self-hosted OAuth 2.1 / OIDC identity provider
  description: Self-hosted OAuth 2.1 / OIDC identity provider built on BetterAuth. Multi-app RBAC, MFA (TOTP + backup codes), subscription plans with feature flags, consumption tracking, organizations, social login, login history, and MCP server integration.
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
::::u-page-feature{icon="i-lucide-shield-check" title="OAuth 2.1 / OIDC compliant" description="Full authorization code flow with PKCE, client credentials, token introspection, JWKS, and standard discovery endpoints."}
::::

::::u-page-feature{icon="i-lucide-layers" title="Multi-application RBAC" description="Each registered application gets its own isolated role and permission model. Users carry different roles across applications; claims are injected into JWT access tokens when the matching scope is requested."}
::::

::::u-page-feature{icon="i-lucide-fingerprint" title="MFA — TOTP and backup codes" description="Two-factor authentication via TOTP authenticator apps, with backup codes. Per-application MFA enforcement is configurable. Passkey (WebAuthn) endpoints are enabled server side."}
::::

::::u-page-feature{icon="i-lucide-credit-card" title="Subscription plans" description="Define subscription plans with arbitrary feature flags per application. Stripe integration creates products and prices automatically. Plan and feature data are included in access tokens."}
::::

::::u-page-feature{icon="i-lucide-bar-chart-2" title="Consumption tracking" description="Record arbitrary numeric counters (API calls, storage used, credits spent) against any user/application pair. Raw entries and running aggregates are stored in PostgreSQL."}
::::

::::u-page-feature{icon="i-lucide-building-2" title="Organization support" description="Multi-tenant organizations with owner / admin / member roles. The org_id claim is injected into access tokens when the org scope is requested, enabling backend services to scope data by tenant."}
::::
::::u-page-feature{icon="i-lucide-globe" title="Social login" description="Google and GitHub OAuth providers. Per-application allow-list gating controls which providers are available to each client."}
::::
::::u-page-feature{icon="i-lucide-clock" title="Login history" description="Every successful login is recorded with IP address, user-agent, and application context. Available via the admin dashboard and API for audit purposes."}
::::
::::u-page-feature{icon="i-lucide-terminal" title="MCP server integration" description="Any MCP client can authenticate via OAuth 2.1 Authorization Code + PKCE and receive a JWT access token with roles, permissions, and feature claims. See the MCP integration guide for complete examples."}
::::
::::u-page-feature{icon="i-lucide-wallet" title="Credit wallet & LLM gateway" description="One prepaid euro balance per user, shared by every application. A LiteLLM gateway authenticated with auth-service tokens bills each call against it; users top up with Stripe, administrators audit everything."}
::::
::::u-page-feature{icon="i-lucide-arrow-right-left" title="Integrate or migrate" description="Step-by-step guides to plug a third-party application into auth-service, give it LLM access with credit control, or move an existing Okta or Keycloak deployment over."}
::::
::::u-page-feature{icon="i-lucide-palette" title="Custom templates & branding" description="Override the login, register and other server-rendered pages per application, and the transactional emails globally, via TEMPLATES_DIR. APP_NAME and APP_LOGO_URL drive the branding."}
::::
:::
