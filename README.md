<p align="center">
  <img src="frontend/public/icon-512.png" alt="CIRCLE Authentication logo" width="140" />
</p>

<h1 align="center">CIRCLE Authentication</h1>

<p align="center">
  <em>Self-hosted OAuth 2.1 / OIDC identity provider — your applications, your users, your keys.</em>
</p>

<p align="center">
  <a href="https://github.com/circle-rd/auth-service/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/circle-rd/auth-service/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: GPL v3" src="https://img.shields.io/badge/License-GPLv3-blue.svg"></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/node-22-3c873a?logo=node.js&logoColor=white"></a>
  <a href="https://better-auth.com"><img alt="BetterAuth" src="https://img.shields.io/badge/BetterAuth-1.7-black.svg"></a>
  <a href="https://vuejs.org"><img alt="Vue" src="https://img.shields.io/badge/Vue-3-4FC08D.svg?logo=vuedotjs&logoColor=white"></a>
  <a href="https://github.com/circle-rd/auth-service/pkgs/container/auth-service"><img alt="Container" src="https://img.shields.io/badge/ghcr.io-auth--service-blue?logo=docker&logoColor=white"></a>
</p>

<p align="center">
  <img src="docs-site/public/screenshots/dashboard.png" alt="CIRCLE Authentication admin dashboard, shown with demo data" width="100%" />
</p>

Register your applications, give each one its own roles, secure sign-in with
passkeys and TOTP, and meter what people consume — including through a
[LiteLLM](https://docs.litellm.ai) gateway — from a single admin console. It
centralizes authentication across your own applications, with per-app roles,
organizations, MFA, subscription billing and a prepaid credit wallet.

Full documentation: **https://docs.circle-cyber.com/auth-service**

## Principles

- **Centralized, standards-first auth.** A single OAuth 2.1 / OIDC provider for
  every consuming application, built on the specs (PKCE, RFC 8707 resource
  indicators, discovery, JWKS) rather than on custom tokens.
- **Self-hosted and sovereign.** You run it, you own the data and the keys. No
  third-party dependency in the critical path.
- **Secure by default, fail-closed.** Unknown OAuth clients are rejected,
  administrative privileges are hierarchical, passwordless flows respect 2FA,
  and authorization failures never fall back to open access.
- **Multi-tenant ready.** Organizations model distributors, resellers and their
  end-clients, with the active organization exposed as an `org_id` claim.
- **Product-grade, not a demo.** An embedded admin dashboard, migrations run at
  startup, structured logs, health checks and published container images.

## Features

**Authentication**

- Email / password with verification, password reset and change-email.
- Passkeys (FIDO2) and TOTP two-factor with backup codes, plus admin-enforced MFA.
- Social sign-in (Google, GitHub) restricted per application.
- Opt-in passwordless: magic link and email OTP (blocked for 2FA accounts).
- Registration policy per application, with invitations and bulk user import.
- Opt-in Have I Been Pwned checks, CAPTCHA and last-login-method hints.
- Session management, revocation and login history.

**Authorization**

- OAuth 2.1 / OIDC provider with discovery, PKCE, consent and refresh-token rotation.
- Opt-in device authorization grant and OIDC back-channel logout.
- Compatibility profiles (Okta, Auth0, Keycloak) and migration guides to switch
  from another identity provider with as few application changes as possible.
- Applications as first-class OAuth clients with per-app scopes and redirect URIs.
- Protected resources (RFC 8707) and machine-to-machine `client_credentials` tokens.
- Per-application roles and permissions, delivered as JWT claims.
- Organizations (multi-tenant) with members, roles and email invitations.

**Billing & metering**

- Subscription plans with feature flags surfaced in access tokens.
- Stripe integration with an idempotent webhook handler.
- Usage / consumption tracking API, scoped per application.
- Accounting journal of every credit and billing movement.

**Credit wallet & LLM gateway**

- One prepaid euro wallet per user, shared by every application: top-ups (Stripe
  or manual invoice), a signed append-only ledger, spend statistics.
- Optional [LiteLLM](https://docs.litellm.ai) gateway (models and MCP servers)
  that accepts auth-service access tokens, checks the credit before each call and
  bills the cost afterwards; the admin interface signs in through auth-service.
- Exchange rate and margin editable by superadmins; a reconciliation script
  compares the gateway's spend logs with the ledger.

**Platform**

- Node.js 22 · Fastify 5 · BetterAuth 1.7 · Drizzle ORM · PostgreSQL 17 · Zod.
- Vue 3 admin SPA (users, applications, plans, roles, organizations, wallets,
  accounting, runtime configuration), in English and French.
- Optional public landing page and per-application branding.
- SMTP email pipeline with Eta templates, overridable per application.
- Helmet security headers, rate limiting (optionally Redis-backed), structured
  (pino) logging, `/health`.
- Published Docker images (`nightly`, `latest`, version tags) and GitHub Actions CI.

## Architecture

```
auth-service/
├── 📁 src/
│   ├── index.ts           Entrypoint — starts the server and runs migrations
│   ├── server.ts          buildServer() — Fastify app factory, hooks, error handling
│   ├── auth.ts            The BetterAuth instance (plugins, hooks, callbacks)
│   ├── config.ts          Environment validation (Zod) and typed config
│   ├── errors.ts          ApiError class + ERR code registry (AUTH_001, …)
│   ├── middleware.ts      requireAdmin / requireSession / requireFullSession
│   ├── bootstrap.ts       One-time startup: superadmin seeding
│   ├── migrate.ts         Drizzle migration runner (before server boot)
│   ├── logger.ts          Shared pino logger
│   ├── 📁 db/             Drizzle client, business schema + BetterAuth schema
│   ├── 📁 routes/         HTTP layer — thin handlers: validate → service → reply
│   │   └── 📁 admin/      Admin-only routes (users, apps, plans, roles, orgs, …)
│   ├── 📁 services/       Business logic: claims, MFA, Stripe, OAuth resources/tokens,
│   │   │                  email, templates, login history, social providers
│   │   └── 📁 mail/       Email transports (SMTP / capture / noop)
│   └── 📁 tests/          Integration tests (real PostgreSQL container, global setup)
├── 📁 frontend/           Vue 3 admin SPA (Vite · Pinia · Tailwind v4)
│   ├── vite.config.ts     Dev server and build config
│   └── 📁 src/
│       ├── main.ts        App bootstrap
│       ├── App.vue        Root component
│       ├── style.css      Tailwind entry point / global styles
│       ├── 📁 api/        Typed fetch wrappers, one module per domain
│       ├── 📁 router/     Routes and navigation guards
│       ├── 📁 stores/     Pinia stores (auth, users, applications, …)
│       ├── 📁 views/      Page-level components (dashboard, users, apps, profile, consent, login…)
│       ├── 📁 components/
│       │   ├── 📁 ui/         Reusable primitives (buttons, inputs, modals, tables…)
│       │   ├── 📁 layout/     Shell: header, sidebar, layout wrappers
│       │   └── 📁 applications/ · 📁 users/ · 📁 profile/ · 📁 auth/ · 📁 branding/
│       ├── 📁 composables/ Reusable logic (useAsync, usePagination, useToast, useTheme…)
│       ├── 📁 i18n/       Locale files (en, fr) and setup
│       ├── 📁 types/      Shared frontend types
│       └── 📁 mocks/      Fixture data for local development
├── 📁 drizzle/            Generated SQL migrations
├── 📁 templates/          Eta templates for auth pages and emails
├── 📁 docs-site/          Documentation website (Nuxt/Docus)
├── 📁 tests/e2e/          Playwright end-to-end suite
├── 📁 .github/            CI, nightly and release workflows
├── AGENTS.md              Canonical technical standards (mandatory)
├── CONTRIBUTING.md        Contributor onboarding, Git/PR process
├── Dockerfile             Three-stage build (frontend → backend → runtime)
├── docker-compose.yml     Single recipe: postgres + auth-service
└── .env.example           Documented environment template
```

Layering rule: `routes/` only validate input and call services; `services/`
hold all business logic; `db/` owns schema and migrations. The full standards
(separation of concerns, error codes, testing, security) are defined in
[AGENTS.md](AGENTS.md).

The admin SPA under `frontend/` is a self-contained Vite app: pages live in
`views/`, server access in `api/`, global state in `stores/`, and reusable
pieces in `components/` (`ui/` for primitives, one folder per domain). It
ships English and French locales and is built into the Docker image.

## Production install

`docker-compose.yml` can pull the published image. A minimal deployment is:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: auth
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: auth
    volumes: ["pg:/var/lib/postgresql/data"]
    restart: unless-stopped

  auth-service:
    image: ghcr.io/circle-rd/auth-service:latest
    environment:
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set a 32-byte random secret}
      BETTER_AUTH_URL: https://auth.example.com
      DATABASE_URL: postgres://auth:change-me@postgres:5432/auth
      ADMIN_EMAIL: admin@example.com
      ADMIN_PASSWORD: change-me-with-12-chars-or-more
      REQUIRE_EMAIL_VERIFICATION: "true"
      SMTP_HOST: smtp.example.com
    ports: ["3001:3001"]
    depends_on: [postgres]
    restart: unless-stopped

volumes:
  pg:
```

```sh
BETTER_AUTH_SECRET=$(openssl rand -base64 32) docker compose up -d
```

Then put a TLS-terminating reverse proxy (Traefik, nginx, Caddy) in front of
port 3001 and set `BETTER_AUTH_URL` to the public URL. Pin a version tag
(`:X.Y.Z`) instead of `:latest` for reproducible upgrades.

**Image tags**

| Tag            | Source                                     |
| -------------- | ------------------------------------------ |
| `:latest`      | Latest tagged release (recommended)        |
| `:nightly`     | Built from `develop` on every nightly run  |
| `:X.Y` / `:X.Y.Z` | Pinned releases                         |

## Documentation

The full documentation is published at
[docs.circle-cyber.com/auth-service](https://docs.circle-cyber.com/auth-service):
deployment options, the environment-variable reference, email/SMTP setup,
custom templates, concepts (RBAC, organizations, plans, claims), guides and
the complete local development workflow.

**For AI agents** — the same documentation is exposed through a built-in MCP
server (HTTP), so agents can query it directly:

| Environment | MCP endpoint |
| ----------- | ------------ |
| Production  | `https://docs.circle-cyber.com/auth-service/mcp` |
| Local dev   | `http://localhost:3000/mcp` (run `npm run dev` in `docs-site/`) |

A ready-made client configuration ships in
[`docs-site/.vscode/mcp.json`](docs-site/.vscode/mcp.json).

**Contributing** — the development rules defined in [AGENTS.md](AGENTS.md)
(naming, TypeScript strictness, error handling, testing, security) and the
contribution process in [CONTRIBUTING.md](CONTRIBUTING.md) are **mandatory**
for any contribution to this repository.

## Roadmap

- **DPoP** sender-constrained access tokens: the admin surface and tests are missing.
- **CAPTCHA widget** in the sign-in pages (the server-side check already ships, opt-in).
- **Internationalization** of the auth pages.
- **Quality**: raise route/service test coverage to ≥ 80 % and split the largest modules.
- **Loose ends**: wire the remaining social providers, add a database probe to `/health`.

Detailed phase tracking, the gap-analysis re-evaluation and what shipped
recently: [project roadmap](docs-site/content/docs/5.project/1.roadmap.md).
Functional specifications:
[docs-site/content/docs/5.project/2.specifications.md](docs-site/content/docs/5.project/2.specifications.md).

## Credits & license

Built and maintained by [CIRCLE](https://circle-cyber.com). Stands on the
shoulders of [BetterAuth](https://better-auth.com), [Fastify](https://fastify.dev),
[Drizzle ORM](https://orm.drizzle.team), [PostgreSQL](https://www.postgresql.org)
and [Vue](https://vuejs.org).

Licensed under the **GNU GPL v3 or later** — see [LICENSE](LICENSE).
A commercial license is available for use cases the GPL does not fit:
`contact [AT] circle-cyber.com`.
