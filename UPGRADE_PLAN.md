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
| 3 | Design-level hardening | ✅ (M-02/L-08 accepted, L-10 won't-fix) |
| 4 | Refactoring to AGENTS.md rules (core) | ✅ (remainder → Phase 6) |
| 5 | New BetterAuth features (optional Redis, DPoP, …) | ⬜ |
| 6 | Quality: types, file split, coverage ≥80 %, SPECS sync | ⬜ |
| 7 | Loose ends (social providers, role cast, health probe, Dependabot) | ⬜ |

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
Phase 2 is a **breaking release**: recreate the database (`docker compose down -v && docker compose pull && docker compose up -d`), then re-register downstream clients. The consolidated baseline is regenerated until the first production deploy, so an already-initialised database will fail `runMigrations()` with an actionable error — recreate it. Also set `TRUST_PROXY_HOPS=1` when running behind a reverse proxy (default is now `0`, secure).

### Post-review fixes
- 2FA guard also covers `/sign-in/social` (idToken branch creates a session).
- Stripe invoice/delete handlers filter by `(user_id, application_id, plan_id)` so stale old-plan events cannot flip the current subscription; the `user_applications.subscription_plan_id` mirror is cleared when inactive/canceled; `stripe_events` is purged after 30 days; plan→application lookups are cached.
- `requireAdmin` now emits `AUTH_011` (403) consistently; unused `AUTH_002` removed.
- Last-superadmin demotion is a single conditional UPDATE (race-safe).
- Bootstrap rejects the shipped `.env.example` password pattern.


## Phase 3 — Design-level hardening (✅ done)

| ID | Item | Status |
| -- | ---- | ------ |
| H-03 | Passwordless/social sign-in blocked for 2FA-enabled accounts (top-level `after` hook, fail-closed; covers `/callback/`, magic-link, email-OTP, one-tap and the social `idToken` branch) | ✅ |
| H-06 | `select-org.html` XSS (name/slug via `textContent`, JSON via escaped hidden input) | ✅ |
| M-01 | Credentialed CORS scoped to dashboard origins; app origins only on `/api/auth/*` | ✅ |
| M-03 | `disableSettingJwtHeader` (no more `set-auth-jwt`) | ✅ |
| M-04 | Request logs strip query strings (tokens) | ✅ |
| M-05 | `allowRegister` defaults to `false` (DB + API + pages) | ✅ |
| M-07 | `TRUST_PROXY_HOPS` defaults to `0` | ✅ |
| M-08 | `@fastify/helmet` (HSTS, nosniff, frame-ancestors, CSP) | ✅ |
| M-09 | Stripe webhook idempotency (`stripe_events` claim + release on error) | ✅ |
| L-01 | Slug validated with `^[a-z0-9-]+$` before template path resolution | ✅ |
| L-03 | Last superadmin cannot be demoted via PATCH (atomic) | ✅ |
| L-04 | Weak/default bootstrap password refused in production | ✅ |
| L-05 | Dockerfile runs as `USER node` | ✅ |
| M-02 | Cross-subdomain session cookie — **accepted**: kept opt-in via `SESSION_DOMAIN`, documented trust trade-off | 🚫 |
| L-08 | Login history IP/UA on OAuth issuance — **accepted**: plugin callback exposes no request headers | 🚫 |
| L-10 | Pin GitHub Actions by SHA — **won't fix**: deferred to Dependabot (Phase 7) | 🚫 |

## Phase 4 — Refactoring to AGENTS.md (✅ core done; remainder → Phase 6)

- [x] `src/middleware.ts` (`requireAdmin`, `requireSession`, `requireFullSession`, `getCallerRole`); 9 duplicated `requireAdmin` copies + 2 session helpers removed
- [x] `src/logger.ts` (pino); `console.*` removed from bootstrap/index/auth/mail
- [x] `ApiError`: added `AUTH_011` (403); authorization denials no longer reuse `AUTH_001`; unused `AUTH_002` removed
- [x] Global error handler maps `ZodError` → 400 and BetterAuth `APIError` → its status/body
- [x] Fail-fast: bootstrap no longer swallows DB errors; `getCallerRole` no longer defaults to `"admin"`
- [x] `user_subscriptions` upsert on `(user_id, application_id)` (plan changes no longer 500 and loop on Stripe retries); `user_applications.subscription_plan_id` kept as a mirror

## Phase 6 — Quality & coverage (⬜)

- [ ] `src/types.ts` centralisation (user/app/claims types still file-local)
- [ ] Split `applications.ts` (<1000 lines) into applications + application-users
- [ ] Rename `adminConsumption.ts` → kebab-case
- [ ] Explicit `.select({…})` / `.returning({…})` sweep; transaction audit
- [ ] Coverage ≥80 % gate on `routes/**` + `services/**`; add missing tests for `user.ts`, `stripe-webhook.ts`, `bootstrap.ts`, `migrate.ts`
- [ ] `SPECS.md` error-code sync

## Phase 7 — Loose ends (⬜)

- [ ] Wire LinkedIn / Microsoft / Apple in `auth.ts`, or remove them from `config.ts`
- [ ] Replace the `createUser` role cast in `bootstrap.ts` with a typed path
- [ ] Add a DB connectivity probe to `GET /health`
- [ ] Add Dependabot (npm + GitHub Actions)

## Phase 5 — New features (⬜)
- **Redis is optional.** Compose recipes get a `redis` service behind a profile; `REDIS_URL` unset → in-memory behaviour unchanged.
- Native BetterAuth rate limit with secondary storage (`@better-auth/redis-storage`) when `REDIS_URL` is set, mapped to `RATE_001`/`MAIL_003`
- `haveIBeenPwned`, `captcha`, `lastLoginMethod`, `@better-auth/i18n`
- Back-channel logout per client, DPoP, device authorization, CIMD/DCR (evaluate)
- Decision pending: `auth.api.adminCreateOAuthClient` vs. hand-written client insertion
