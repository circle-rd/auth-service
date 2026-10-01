# Auth Service — Roadmap & Gap Analysis

> Generated: 2026-03-28 — Mise à jour: 2026-10-01 (revu après phases 0–4)
> Based on: full codebase audit vs [`SPECS.md`](SPECS.md)

---

## Programme — Security hardening, BetterAuth 1.7 & quality

Detailed tracking: [`UPGRADE_PLAN.md`](UPGRADE_PLAN.md).

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 0 | Lint / format / coverage / CI guardrails | ✅ |
| 1 | Urgent security fixes (fail-closed OAuth guard, admin hierarchy, env booleans, token revocation, M2M verification) | ✅ |
| 2 | BetterAuth 1.6.23 → 1.7.7 (schema, protected resources, M2M E2E) | ✅ |
| 3 | Design-level hardening | ✅ (M-02/L-08 accepted, L-10 won't-fix) |
| 4 | Refactoring to `AGENTS.md` rules (core) | ✅ (remainder → Phase 6) |
| 5 | New features (optional Redis, DPoP, back-channel logout…) | ⬜ |
| 6 | Quality: types, file split, coverage ≥80 %, SPECS sync | ⬜ |
| 7 | Loose ends (social providers, role cast, health probe, Dependabot) | ⬜ |

---

## Re-evaluation of the previous audit

Every item from the earlier "Missing Features / Broken / Sprint plan" audit is
now classified. Resolved = implemented; Won't fix = deliberate decision.

| # | Previous finding | Status | Evidence / decision |
| - | ---------------- | ------ | ------------------- |
| 1 | Dashboard sessions field mismatch (`list` vs `sessions`) | ✅ Resolved | `src/routes/admin/sessions.ts` returns `sessions`; `DashboardView.vue` reads `res.sessions` |
| 2 | Integration suite missing (`vitest.integration.config.ts`) | ✅ Resolved | Phase 0 — 17 integration files, PostgreSQL 17 |
| 3 | ESLint / Prettier / husky / lint-staged missing | ✅ Resolved | Phase 0 (flat config, pre-commit, CI) |
| 4 | Per-user `isMfaRequired` not enforced | ✅ Resolved | `userMustSetupMfa()` blocks OAuth token issuance (`AUTH_004`) |
| 5 | Stripe webhook handler missing | ✅ Resolved | `src/routes/stripe-webhook.ts` + idempotency ledger |
| 6 | Last-superadmin guard on deletion | ✅ Resolved | Guard existed on delete; Phase 3 added demotion guard (atomic) |
| 7 | `/admin/applications/new` dedicated route | 🚫 Won't fix | Modal-based create is the accepted UX |
| 8 | User detail shows plan UUID instead of name | ✅ Resolved | Left join on `subscriptionPlans.name` in `users.ts` |
| 9 | LinkedIn / Microsoft / Apple providers not wired | ⬜ New chantier | Phase 7 — config accepts them but `auth.ts` only wires Google/GitHub |
| 10 | Bootstrap role cast `"superadmin" as "admin"` | ⬜ New chantier | Phase 7 — harmless today, fragile on BetterAuth upgrades |
| 11 | Passkeys as a true second factor | 🚫 Won't fix | BetterAuth limitation; TOTP/YubiKey-OATH covers 2FA |
| 12 | Rate limiting on auth endpoints | ✅ Resolved | Two in-memory buckets in `server.ts` (`RATE_001`/`MAIL_003`) |
| 13 | Structured logging | ✅ Resolved | pino via Fastify + shared `src/logger.ts` |
| 14 | Security audit (PKCE, rotation, CORS) | ✅ Resolved | Phases 1–3 (PKCE enforced, JWKS rotation, CORS scoped, helmet) |
| 15 | Health check DB connectivity probe | ⬜ New chantier | Phase 7 — `/health` is static today |
| 16 | Monitoring / alerting | 🚫 Won't fix | Operational concern, out of repo scope |
| 17 | Coverage ≥80 % on `routes/**` + `services/**` | ⬜ New chantier | Phase 6 — measurable now, threshold not yet met |
| 18 | BetterAuth plugin-hook integration tests | 🟡 Partial | Phase 6 — security-hardening + M2M tests cover key hooks |
| 19 | `any` usages in auth/consumption | ✅ Resolved | Phase 1 removed both |
| 20 | `docker-compose.dev.yml` redundant/broken | ✅ Resolved | Merged into a single `docker-compose.yml` (prebuilt image by default) |

### Deliberately accepted (documented, not defects)

- **M-02 cross-subdomain session cookie** — kept opt-in via `SESSION_DOMAIN`; sharing the IdP cookie across subdomains is a deliberate trade-off.
- **L-08 login IP/UA on OAuth issuance** — BetterAuth's token-issuance callback exposes no request headers; the parent session row carries them.
- **L-10 pin GitHub Actions by SHA** — deferred to Dependabot (Phase 7) instead of hand-pinned SHAs.

---

## Open workstreams

### Phase 5 — New features (planned)

- Optional Redis secondary storage for the native BetterAuth rate limiter (`REDIS_URL` unset → in-memory, unchanged; compose `redis` service behind a profile).
- Back-channel logout (per client), DPoP, device authorization.
- `haveIBeenPwned`, `captcha`, `lastLoginMethod`, `@better-auth/i18n`.
- Evaluate CIMD/DCR and `auth.api.adminCreateOAuthClient` vs. the hand-written client insertion.

### Phase 6 — Quality & coverage

- `src/types.ts` centralisation; split `applications.ts` (<1000 lines); rename `adminConsumption.ts` → kebab-case.
- Explicit `.select({…})` / `.returning({…})` sweep; transaction audit.
- Raise `routes/**` + `services/**` coverage to ≥80 % and make it gate CI; add tests for `user.ts`, `stripe-webhook.ts`, `bootstrap.ts`, `migrate.ts`.
- `SPECS.md` error-code sync.

### Phase 7 — Loose ends

- Wire LinkedIn / Microsoft / Apple in `auth.ts` (or drop them from `config.ts` to avoid a silent no-op).
- Replace the `createUser` role cast in `bootstrap.ts` with a typed path.
- Add a DB connectivity probe to `GET /health`.
- Add Dependabot (npm + GitHub Actions), which also resolves L-10.

---

## Status at a glance

| Area | State |
| ---- | ----- |
| Email/password, verification, password reset, change-email | ✅ |
| Magic-link / email-OTP (opt-in), passwordless 2FA guard | ✅ |
| TOTP 2FA + backup codes, admin force-MFA | ✅ |
| Passkeys (primary factor), YubiKey via OATH-TOTP | ✅ |
| OAuth 2.1 / OIDC (PKCE, consent, refresh, discovery, JWKS, rotation) | ✅ |
| Protected resources (RFC 8707) + per-client linking | ✅ |
| Machine-to-machine (`client_credentials`) + consumption API | ✅ |
| Orgs, per-app roles/permissions, subscriptions + Stripe webhook | ✅ |
| Admin dashboard (users, apps, plans, roles, sessions, consumption) | ✅ |
| Guardrails (ESLint/Prettier/husky, CI, integration tests PG17) | ✅ |
| Coverage ≥80 % gate | ⬜ Phase 6 |
| Rate-limit shared storage (multi-instance) | ⬜ Phase 5 |

---

## Infrastructure

- **Single `docker-compose.yml`** — `postgres` + `auth-service` (prebuilt image or `--build`), healthcheck on `/health`, postgres exposed on 5433 for host-based dev.
- **Images** — published to `ghcr.io/circle-rd/auth-service` as `:nightly` (develop), `:latest` (release) and version tags. Docs recommend pulling these over building.
- **Dockerfile** — three-stage (frontend → backend → runtime), runs as `USER node`.
- **Migrations** — `runMigrations()` at startup; the consolidated baseline is regenerated until the first production release, so reinitialised databases must be recreated (`docker compose down -v`).

---

## Recently Shipped

- **Phase 7 groundwork / compose**: single functional `docker-compose.yml`; docs prioritise the published `latest`/`nightly` images; production install fixed (`husky || true` under `--prod`).
- **Phase 3**: 2FA enforced for passwordless/social sign-in, `select-org` XSS fixed, credentialed CORS scoped to the dashboard, request logs token-free, `allowRegister`/`TRUST_PROXY_HOPS` secure defaults, helmet headers, Stripe webhook idempotency, last-superadmin protection, non-root container.
- **Phase 4**: shared `middleware.ts` and `logger.ts`, `AUTH_011` 403 + Zod/BetterAuth error mapping, fail-fast bootstrap, `user_subscriptions` upsert fix.
- **Phase 2**: BetterAuth 1.7.7, regenerated baseline, protected resources, client metadata, native `revokeSession`, local-JWKS M2M verification with E2E test, JWKS rotation.
- **Phase 1**: OAuth client management admin-only, fail-closed access guard, admin hierarchy hook, strict boolean env parsing, provider secrets no longer exposed, OAuth token revocation on ban/revocation/rotation.
- **Phase 0**: ESLint + Prettier + husky/lint-staged, coverage tooling, CI on PR, integration tests on PostgreSQL 17, tracked build artefacts removed.
