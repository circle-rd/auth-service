# auth-service

Self-hosted OAuth 2.1 / OIDC identity provider built on [BetterAuth](https://better-auth.com) v1.5.6.

Features: email/password auth, MFA (TOTP + YubiKey FIDO2), multi-app RBAC, subscription plans with feature flags, consumption tracking, **organization management** (multi-tenant ready), and an embedded Vue 3 admin SPA.

---

## Stack

| Layer         | Tech                                       |
| ------------- | ------------------------------------------ |
| Runtime       | Node.js 22, TypeScript (ESM)               |
| Web framework | Fastify 5                                  |
| Auth engine   | BetterAuth + `@better-auth/oauth-provider` |
| ORM           | Drizzle ORM + `postgres` driver            |
| Database      | PostgreSQL 17                              |
| Frontend      | Vue 3 + Vite + Tailwind CSS v4             |
| Tests         | Vitest + Supertest                         |
| Container     | Docker (multi-stage build)                 |

---

## Project structure

```
auth-service/
├── src/
│   ├── index.ts              # Fastify server entry point
│   ├── auth.ts               # BetterAuth configuration & plugins
│   ├── config.ts             # Zod-validated env config
│   ├── errors.ts             # ApiError class + error codes
│   ├── bootstrap.ts          # Superadmin auto-creation at startup
│   ├── migrate.ts            # Programmatic Drizzle migrations
│   ├── db/
│   │   ├── index.ts          # Drizzle + postgres connection
│   │   └── schema.ts         # All custom table definitions
│   ├── services/
│   │   └── claims.ts         # OIDC custom claims builder (RBAC + features)
│   └── routes/
│       ├── health.ts         # GET /health
│       ├── consumption.ts    # Consumption tracking API
│       └── admin/
│           ├── applications.ts
│           ├── organizations.ts   # Organization CRUD + member & invitation management
│           ├── roles.ts
│           ├── plans.ts
│           └── users.ts
├── frontend/                 # Vue 3 SPA (built to frontend-dist/)
│   └── src/
│       ├── views/            # Login, register, profile, consent, admin pages
│       ├── stores/           # Pinia auth store
│       ├── router/           # Vue Router with auth guards
│       └── locales/          # i18n (en, fr)
├── drizzle/                  # Generated SQL migrations
├── Dockerfile                # Multi-stage build
├── docker-compose.yml        # Production
├── docker-compose.dev.yml    # Dev (postgres only + hot-reload server)
└── .env.example
```

---

## Development setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker + Docker Compose

### 1. Environment

```sh
cp .env.example .env
# Edit .env — at minimum set BETTER_AUTH_SECRET and BETTER_AUTH_URL
openssl rand -base64 32   # use this as BETTER_AUTH_SECRET
```

### 2. Start the database

```sh
docker compose -f docker-compose.dev.yml up -d postgres
```

The postgres container is exposed on **port 5433** (to avoid conflicts with a local postgres on 5432).

### 3. Push the schema

```sh
pnpm install
pnpm db:push
```

`db:push` syncs the Drizzle schema directly to the DB without generating migration files — ideal for development.

### 4. Start the backend

```sh
pnpm dev      # tsx watch — hot-reload on file changes
```

Server: <http://localhost:3001>

### 5. Start the frontend (optional, for SPA development)

```sh
cd frontend
pnpm install
pnpm dev      # Vite dev server with HMR
```

Frontend: <http://localhost:5173> (proxied to the backend at 3001)

> For quick iteration you can also just use the backend on port 3001 — the Vue SPA is served from `frontend-dist/` when built.

---

## API routes

| Method             | Path                                        | Description                                              |
| ------------------ | ------------------------------------------- | -------------------------------------------------------- |
| `GET`              | `/health`                                   | Health check                                             |
| `ALL`              | `/api/auth/*`                               | BetterAuth handler (login, register, OAuth2, OIDC, MFA…) |
| `GET/POST`         | `/api/admin/applications`                   | List / create applications                               |
| `GET/PATCH/DELETE` | `/api/admin/applications/:id`               | Application CRUD                                         |
| `POST`             | `/api/admin/applications/:id/rotate-secret` | Rotate client secret                                     |
| `GET/POST/DELETE`  | `/api/admin/applications/:id/roles`         | Per-app role management                                  |
| `GET/POST/DELETE`  | `/api/admin/applications/:id/permissions`   | Per-app permission management                            |
| `GET/POST/DELETE`  | `/api/admin/applications/:id/plans`         | Subscription plan management                             |
| `GET/PATCH`        | `/api/admin/users`                          | User list / update                                       |
| `POST`             | `/api/admin/users/:id/disable`              | Ban user                                                 |
| `POST`             | `/api/admin/users/:id/enable`               | Unban user                                               |
| `GET/POST`         | `/api/admin/organizations`                  | List / create organizations                              |
| `GET/DELETE`       | `/api/admin/organizations/:id`              | Get / delete an organization                             |
| `GET/POST`         | `/api/admin/organizations/:id/members`      | List members / add a member directly                     |
| `DELETE`           | `/api/admin/organizations/:id/members/:uid` | Remove a member                                          |
| `PATCH`            | `/api/admin/organizations/:id/members/:mid/role` | Update a member's role                              |
| `GET/POST`         | `/api/admin/organizations/:id/invitations`  | List invitations / send an invitation by email           |
| `DELETE`           | `/api/admin/organizations/:id/invitations/:iid` | Cancel a pending invitation                         |
| `POST`             | `/api/consumption`                          | Record consumption (client_credentials token)            |
| `GET`              | `/api/consumption/:userId/:appId`           | Get aggregates for user+app                              |
| `DELETE`           | `/api/consumption/:userId/:appId/:key`      | Reset a counter                                          |

### OIDC / OAuth2 endpoints (via BetterAuth)

| Path                                         | Description            |
| -------------------------------------------- | ---------------------- |
| `/api/auth/oauth2/authorize`                 | Authorization endpoint |
| `/api/auth/oauth2/token`                     | Token endpoint         |
| `/api/auth/oauth2/userinfo`                  | UserInfo endpoint      |
| `/api/auth/.well-known/openid-configuration` | Discovery document     |
| `/api/auth/jwks`                             | JSON Web Key Set       |

---

## Organization management

auth-service includes first-class support for **organizations** (companies / tenants) powered by the BetterAuth `organization()` plugin.

### Purpose

The organization model is designed for a **two-tier distribution chain**:

| Tier | Actor | Role |
|------|-------|------|
| 1 | **Reseller / distributor** | Creates and owns organizations representing their end-clients |
| 2 | **Integrator** | Is a member of one or more organizations; manages IT resources scoped to those organizations |

Each organization has a unique `slug` (used as its stable identifier) and optional `logo` + `metadata`. Members are assigned one of three roles: `owner`, `admin`, or `member`.

### The `org_id` claim

When a client requests the `org` scope during an OAuth2 authorization flow, the access token issued by auth-service contains an `org_id` claim set to the user's active organization ID (`session.activeOrganizationId`). Backend services can use this claim to:

- Scope database queries to the organization's data
- Enforce CASL (`@lagarde-cyber/acl`) abilities with `{ org_id }` conditions
- Isolate resources between tenants

### Admin operations

Only users with role `admin` or `superadmin` can create organizations. Member management (add, remove, change role) and invitation flows (invite by email, cancel) are also admin-only operations accessible via the `/api/admin/organizations/*` routes.

Regular users can belong to multiple organizations as members but cannot create them.

---

## Database migrations

```sh
# Generate migration files from schema changes
pnpm db:generate

# Apply migrations (production-style)
pnpm db:migrate

# Push schema directly (dev only — no migration files)
pnpm db:push
```

In production (Docker), migrations run automatically at container startup via `runMigrations()` in `src/migrate.ts`.

---

## Production deployment

### Build & run with Docker Compose

```sh
# Fill in production values in .env (never commit this file)
docker compose build
docker compose up -d
```

The service is exposed on the port defined by `PORT` (default 3001).  
Add a reverse proxy (Traefik, nginx, Caddy) in front of it for TLS termination.

### Environment variables reference

| Variable             | Required | Description                                       |
| -------------------- | -------- | ------------------------------------------------- |
| `PORT`               | no       | Server port (default: 3001)                       |
| `HOST`               | no       | Bind address (default: 0.0.0.0)                   |
| `BETTER_AUTH_SECRET` | **yes**  | 32-byte random secret — `openssl rand -base64 32` |
| `BETTER_AUTH_URL`    | **yes**  | Public base URL, e.g. `https://auth.example.com`  |
| `DATABASE_URL`       | **yes**  | Postgres connection string                        |
| `POSTGRES_USER`      | **yes**  | Postgres user (also used by compose)              |
| `POSTGRES_PASSWORD`  | **yes**  | Postgres password                                 |
| `POSTGRES_DB`        | **yes**  | Database name                                     |
| `POSTGRES_PORT`      | no       | Host port for postgres (default: 5433 in dev)     |
| `ADMIN_EMAIL`        | no       | Superadmin email — created at first boot          |
| `ADMIN_PASSWORD`     | no       | Superadmin password                               |
| `CORS_ORIGINS`       | no       | Comma-separated allowed origins                   |
| `APP_NAME`           | no       | Display name in UI + TOTP issuer (default: `CIRCLE Auth`) |
| `APP_LOGO_URL`       | no       | Logo URL for UI + favicon (falls back to default) |
| `SMTP_HOST`          | prod¹   | SMTP server host                                  |
| `SMTP_PORT`          | no       | 465 (TLS) │ 587 (STARTTLS, default) │ 25         |
| `SMTP_USER`          | no       | SMTP username (omit for unauthenticated relays)   |
| `SMTP_PASS`          | no       | SMTP password                                     |
| `SMTP_FROM`          | no       | From address (default: `auth-service <no-reply@localhost>`) |
| `MAIL_REPLY_TO`      | no       | Reply-To header added to every outbound email     |
| `REQUIRE_EMAIL_VERIFICATION` | no | `true` in prod by default, `false` elsewhere   |
| `MAGIC_LINK_ENABLED` | no       | Enable `/api/auth/sign-in/magic-link` (default: false) |
| `EMAIL_OTP_ENABLED`  | no       | Enable `/api/auth/email-otp/*` (default: false)   |
| `NODE_ENV`           | no       | `development` or `production`                     |

¹ `SMTP_HOST` is required in production whenever any email flow is active
(`REQUIRE_EMAIL_VERIFICATION`, `MAGIC_LINK_ENABLED`, or `EMAIL_OTP_ENABLED`).
The service refuses to start otherwise.

---

## Email

Auth-service ships its own SMTP pipeline (Nodemailer) and renders every
outbound message from an Eta template. The flows currently wired up:

| Flow                  | Template (`.eml`)               | Triggered by                                    |
| --------------------- | ------------------------------- | ----------------------------------------------- |
| Email verification    | `verify-email.eml`              | sign-up + `/api/auth/send-verification-email`   |
| Password reset        | `reset-password.eml`            | `/api/auth/forget-password`                     |
| Change-email confirm  | `change-email.eml`              | `/api/auth/change-email`                        |
| Magic-link sign-in    | `magic-link.eml`                | `/api/auth/sign-in/magic-link` (opt-in)         |
| Email OTP             | `email-otp.eml`                 | `/api/auth/email-otp/*` (opt-in)                |
| Org invitation        | `org-invitation.eml`            | `/api/admin/organizations/:id/invitations`      |

Each `.eml` file has the same shape:

```
---
subject: Verify your email for <%= it.appName %>
---
<html>...<%= it.url %>...</html>
===TEXT===
Click <%= it.url %> to verify.
```

The `===TEXT===` block is optional; when absent the renderer derives a plain-
text version by stripping tags from the HTML. Eta tags work everywhere
(`<%= it.x %>` HTML-escapes, `<%~ it.x %>` outputs raw, `<% ... %>` is a
JS control-flow block).

### Overriding templates per app

The resolution order matches the `/login` page overrides:

1. `<TEMPLATES_DIR>/<app-slug>/emails/<name>.eml` — per-application override
2. `<TEMPLATES_DIR>/default/emails/<name>.eml`    — global override
3. `templates/default/emails/<name>.eml`          — bundled fallback

Mount your overrides at `TEMPLATES_DIR` (Docker volume) and they take effect
on the next request — cached only in production.

### Local development with Mailhog

```sh
docker run -d --rm --name mailhog -p 1025:1025 -p 8025:8025 mailhog/mailhog
export SMTP_HOST=localhost SMTP_PORT=1025
pnpm dev
# open http://localhost:8025 to read captured mails
```

---

## Tests

```sh
pnpm test          # Run all tests once
pnpm test:watch    # Watch mode
```

Tests use Vitest with a `node` environment. Integration tests requiring a live DB are separated in `vitest.integration.config.ts`.
