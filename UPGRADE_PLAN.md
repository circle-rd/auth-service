# Upgrade & Hardening Plan — BetterAuth 1.7 / Security / Code Quality

> Tracking file for the multi-phase programme started 2026-10-01.
> Status legend: ✅ done · 🟡 in progress · ⬜ todo · ⏸ blocked / to decide.
> Keep this file and the "Programme" section of [`ROADMAP.md`](ROADMAP.md) in sync after every phase.

## Rules of engagement

- **Dependency upgrades in two steps**: (1) try `latest` even across a major; (2) if tests fail, fall back to the patched minor of the current line; (3) if still blocked, discuss.
- **No backward-compatibility code** for pre-production states. Idempotent DB init replayed at startup is acceptable if simple.
- **Public project**: no reference to internal infrastructure or downstream services.
- A phase is done only when `pnpm build:server`, `pnpm test` and `pnpm test:integration` pass (plus `pnpm lint` once Phase 0 lands).

## Progress

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 0 | Guardrails: lint/format/coverage/CI, repo cleanup | ✅ |
| 1 | Urgent fixes independent from the upgrade | ✅ (commit `f757af6`) |
| 2 | BetterAuth upgrade 1.6.23 → 1.7.7 + M2M end-to-end | ✅ |
| 3 | Design-level security hardening | ⬜ |
| 4 | Refactoring to AGENTS.md rules | ⬜ |
| 5 | New BetterAuth features (optional Redis, DPoP, …) | ⬜ |

## Phase 1 — Urgent fixes (✅ done)

| ID | Item | Status |
| -- | ---- | ------ |
| H-04 | Strict env booleans (`z.stringbool`) | ✅ |
| H-05 | `/api/admin/services` no longer returns provider secrets | ✅ |
| C-01 | `clientPrivileges` admin-only; guard fail-closed on unknown client | ✅ |
| H-01 | Hierarchy hook on native `/admin/*` endpoints | ✅ |
| H-02 | `isMfaRequired`, `lastLoginAt` not user-writable | ✅ |
| H-07 | Banned users refused; OAuth tokens revoked on ban / access revocation / secret rotation | ✅ |
| M-06 | `applications.isActive` enforced; `oauth_client.disabled` synced | ✅ |
| M-10 | `/api/consumption` Bearer verified via JWKS/DB, bound to `azp`, fail-closed | ✅ (E2E with a real token deferred to Phase 2) |
| — | Magic link `storeToken: "hashed"` (mitigation of GHSA-965c on 1.6) | ✅ |
| — | Internal infra references removed | ✅ |

## Phase 0 — Guardrails (✅ done)

- [x] ESLint flat config (`eslint.config.js`) — `no-explicit-any` / `consistent-type-imports` errors, `no-console` warn; `pnpm lint` (0 errors, 13 warnings pending Phase 4 logger)
- [x] Prettier + `pnpm format` / `pnpm format:check` (src + root configs; `frontend/`, `tests/`, `templates/`, docs, markdown and `package.json` ignored)
- [x] husky + lint-staged pre-commit
- [x] `@vitest/coverage-v8` + `pnpm test:coverage`; thresholds declared but **not yet gating CI** — current unit coverage ≈40 % on routes/services, to be raised in Phase 4
- [x] CI workflow `.github/workflows/ci.yml` (build, lint, format:check, unit, integration) on PR + main
- [x] Integration tests on PostgreSQL 17
- [x] Removed tracked artefacts: `frontend/src/{i18n/i18n,mocks/mocks,types/types}`, `frontend/vite.config.{js,d.ts}`

## Phase 2 — BetterAuth upgrade (✅ done, 1.6.23 → 1.7.7)

`latest` (1.7.7) installed for `better-auth`, `@better-auth/oauth-provider`, `@better-auth/passkey`, `@better-auth/drizzle-adapter`. No fallback needed: TypeScript surfaced a single rename (`verifyAccessToken` → `verifyJwsAccessToken`) and everything else compiled. The only runtime failure was the BetterAAuth-reported Drizzle schema mismatch, resolved below.

### Schema (single regenerated baseline)
- [x] `src/db/auth-schema.ts` hand-aligned with the 1.7 schema: `jwks.alg/crv`; new `oauth_client` columns and removal of `public`/`type`; new columns on `oauth_refresh_token` / `oauth_access_token` / `oauth_consent`; new tables `oauth_resource`, `oauth_client_resource`, `oauth_client_assertion`
- [x] Per the pre-production exception: deleted `0001`/`0002` + snapshots and regenerated a single `drizzle/0000_initial_schema.sql` (`pnpm db:generate --name initial_schema`)
- [x] `src/migrate.ts` reduced to a plain `migrate()` — removed `POST_BASELINE_PROBES` and the history-reconciliation logic

### Code
- [x] Removed `validAudiences` / `OAUTH_VALID_AUDIENCES` entirely. Protected resources are now `oauth_resource` rows keyed by `applications.url`, linked per client via `oauth_client_resource` (`src/services/oauth-resources.ts`, synced from application create/update/delete)
- [x] `applications.ts` writes 1.7 client metadata: `applicationType: "web"`, `tokenEndpointAuthMethod` (`client_secret_basic` / `none`), `grantTypes`, `responseTypes: ["code"]`, `requirePKCE: true`, `clientCredentialsScopes: ["m2m"]` (separate from OIDC scopes)
- [x] Dropped misplaced `silenceWarnings` (option removed in 1.7)
- [x] `DELETE /api/user/sessions/:id` now calls `auth.api.revokeSession`
- [x] M2M verification rewritten on `verifyJwsAccessToken` with a **local JWKS fetch from the `jwks` table** (no self HTTP call), `azp`-based app binding, fail-closed
- [x] JWKS rotation enabled (30-day rotation, 30-day grace)
- [x] Docs / `.env.example` / compose updated for the resource model

### Tests
- [x] End-to-end `client_credentials` → `/api/consumption` (success + cross-application rejection) in `src/tests/m2m-consumption.integration.test.ts`
- [ ] ID-token `email`/`name` claims via a full authorization-code flow (deferred — the claim builders were unchanged and the code compiles)
- [ ] End-session E2E and back-channel logout (deferred to Phase 5)

### Deployment note
Phase 2 is a **breaking release**: recreate the database (`docker compose down -v && docker compose pull && docker compose up -d`), then re-register downstream clients. Existing 1.6 databases are not migrated incrementally — the consolidated baseline is the only path, by design.


## Phase 3 — Design-level hardening (⬜, ~3 days)
H-03 2FA for passwordless/social sign-in · H-06 `select-org.html` XSS · M-01 CORS credentials scoped to dashboard · M-02 cross-subdomain cookie · M-03 `set-auth-jwt` header + dedicated audience · M-04 token-free request logs · M-05 `allowRegister` default + `disableSignUp` · M-07 `TRUST_PROXY_HOPS` default 0 · M-08 helmet/CSP/HSTS · M-09 Stripe idempotency (`stripe_events`) · L-01 slug validation for template path · L-02/L-03 cross-app bindings, last-superadmin demotion · L-04 weak default admin password refused in production · L-05 Dockerfile `USER node` · L-08 login-history reliability · L-10 pin GitHub Actions by SHA

## Phase 4 — Refactoring to AGENTS.md (⬜, ~4–6 days)
`src/middleware.ts` (`requireAdmin`/`requireSession`), `src/types.ts`, `src/logger.ts`, `services/` layer (no DB in routes), split `applications.ts`, rename `adminConsumption.ts`, shared Zod schemas (pagination, uuid params, social providers), `ApiError` clean-up (`AUTH_011` 403…) incl. BetterAuth/Zod error mapping, fail-fast fixes, `user_subscriptions` upsert + single source of truth for plans, explicit `.select({…})`/`.returning({…})`, transactions, `config.ts` partial-config checks, missing tests (`user.ts`, `stripe-webhook.ts`, `app-config.ts`, `bootstrap.ts`, `migrate.ts`), SPECS.md error-code sync.

## Phase 5 — New features (⬜)
- **Redis is optional.** Compose recipes get a `redis` service behind a profile; `REDIS_URL` unset → in-memory behaviour unchanged.
- Native BetterAuth rate limit with secondary storage (`@better-auth/redis-storage`) when `REDIS_URL` is set, mapped to `RATE_001`/`MAIL_003`
- `haveIBeenPwned`, `captcha`, `lastLoginMethod`, `@better-auth/i18n`
- Back-channel logout per client, DPoP, device authorization, CIMD/DCR (evaluate)
- Decision pending: `auth.api.adminCreateOAuthClient` vs. hand-written client insertion
