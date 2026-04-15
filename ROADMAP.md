# Auth Service — Roadmap & Gap Analysis

> Generated: 2026-03-28 — Mise à jour: 2026-04-15  
> Based on: full codebase audit vs [`SPECS.md`](SPECS.md)

---

## Executive Summary

The auth-service is **substantially implemented** and covers the majority of the SPECS.md requirements. The backend is well-structured with Fastify + BetterAuth v1.5+, the OAuth 2.1 / OIDC provider is wired up correctly, and the Vue 3 frontend covers all major user-facing flows. The core authentication pipeline (email/password, MFA, passkeys, OAuth 2.1 Authorization Code + PKCE, consent screen, OIDC claims injection) is fully functional.

**Key gaps** are concentrated in:

1. **Test coverage** — unit tests are mocked smoke tests; `vitest.integration.config.ts` is missing; no real DB integration tests; coverage target of ≥80% is not met
2. **Admin dashboard sessions panel** — the `GET /api/admin/sessions` endpoint is implemented but the frontend reads `data.sessions` while the endpoint returns `data.list`, so the sessions section always shows empty
3. **Missing linting/formatting toolchain** — ESLint, Prettier, Husky, lint-staged are not installed
4. **`/admin/applications/new` route** — SPECS.md §6.3 lists this route with `ApplicationFormView`; the implementation uses a modal instead (functionally equivalent but route is missing)
5. **Per-user `isMfaRequired` enforcement** — the per-user flag is stored and admin-settable but is not enforced at login; only the per-app `isMfaRequired` flag is enforced (at token exchange)

Overall project completeness: **~90% of SPECS.md requirements are implemented**.

---

## Feature Status Matrix

| Feature                                            | Backend Status | Frontend Status | Notes                                                                               |
| -------------------------------------------------- | -------------- | --------------- | ----------------------------------------------------------------------------------- |
| Health check `GET /health`                         | ✅ Complete    | ✅ N/A          | [`src/routes/health.ts`](src/routes/health.ts:6)                                    |
| OIDC discovery endpoints                           | ✅ Complete    | ✅ N/A          | [`src/index.ts:104`](src/index.ts:104)                                              |
| Email + password auth                              | ✅ Complete    | ✅ Complete     | BetterAuth `emailAndPassword` plugin                                                |
| Password reset via email                           | ✅ Complete    | ✅ Complete     | SMTP optional, silently no-ops                                                      |
| Email verification                                 | ⚠️ Partial     | ✅ Complete     | `requireEmailVerification: false` — disabled by default                             |
| Session management                                 | ✅ Complete    | ✅ Complete     | BetterAuth sessions                                                                 |
| TOTP (2FA)                                         | ✅ Complete    | ✅ Complete     | `twoFactor()` plugin                                                                |
| Passkey / YubiKey                                  | ✅ Complete    | ✅ Complete     | Registration + authentication use `@simplewebauthn/browser`                         |
| OAuth 2.1 Authorization Code + PKCE                | ✅ Complete    | ✅ Complete     | `oauthProvider()` plugin                                                            |
| Consent screen                                     | ✅ Complete    | ✅ Complete     | [`frontend/src/views/ConsentView.vue`](frontend/src/views/ConsentView.vue)          |
| Refresh token (`offline_access`)                   | ✅ Complete    | ✅ N/A          | `oauthRefreshToken` table managed by BetterAuth                                     |
| OIDC claims injection (roles/permissions/features) | ✅ Complete    | ✅ N/A          | [`src/services/claims.ts`](src/services/claims.ts)                                  |
| User access gate (app-level)                       | ✅ Complete    | ✅ N/A          | `customIdTokenClaims` throws FORBIDDEN                                              |
| Superadmin bootstrap                               | ✅ Complete    | ✅ N/A          | [`src/bootstrap.ts`](src/bootstrap.ts)                                              |
| Global roles (user/admin/superadmin)               | ✅ Complete    | ✅ Complete     | BetterAuth `admin()` plugin                                                         |
| Application CRUD                                   | ✅ Complete    | ✅ Complete     | [`src/routes/admin/applications.ts`](src/routes/admin/applications.ts)              |
| Client secret rotation                             | ✅ Complete    | ✅ Complete     | `POST /api/admin/applications/:id/rotate-secret`                                    |
| Per-app roles CRUD                                 | ✅ Complete    | ✅ Complete     | [`src/routes/admin/roles.ts`](src/routes/admin/roles.ts)                            |
| Per-app permissions CRUD                           | ✅ Complete    | ✅ Complete     | [`src/routes/admin/roles.ts:187`](src/routes/admin/roles.ts:187)                    |
| Role ↔ permission assignment                       | ✅ Complete    | ✅ Complete     | Toggle matrix in [`AppRolesTab.vue`](frontend/src/components/admin/AppRolesTab.vue) |
| User ↔ app access management                       | ✅ Complete    | ✅ Complete     | [`src/routes/admin/applications.ts:299`](src/routes/admin/applications.ts:299)      |
| Subscription plans CRUD                            | ✅ Complete    | ✅ Complete     | [`src/routes/admin/plans.ts`](src/routes/admin/plans.ts)                            |
| Plan price tiers                                   | ✅ Complete    | ✅ Complete     | `subscriptionPlanPrices` table + Stripe integration                                 |
| Assign/revoke user subscription                    | ✅ Complete    | ✅ Complete     | `POST/DELETE /api/admin/applications/:id/users/:userId/subscription`                |
| Auto-assign default plan on access grant           | ✅ Complete    | ✅ N/A          | [`src/services/claims.ts`](src/services/claims.ts) — fires on grant + auto-provision |
| Auto-assign default role on access grant           | ✅ Complete    | ✅ N/A          | [`src/services/claims.ts`](src/services/claims.ts) — fires on grant + auto-provision |
| Consumption tracking (POST)                        | ✅ Complete    | ✅ N/A          | [`src/routes/consumption.ts:72`](src/routes/consumption.ts:72)                      |
| Consumption aggregates (GET)                       | ✅ Complete    | ✅ Complete     | Admin + user-facing views                                                           |
| Consumption reset (DELETE, admin)                  | ✅ Complete    | ❌ Missing      | Backend exists; no frontend UI to reset                                             |
| Admin users list + search                          | ✅ Complete    | ✅ Complete     | [`src/routes/admin/users.ts:57`](src/routes/admin/users.ts:57)                      |
| Admin user detail                                  | ✅ Complete    | ✅ Complete     | [`src/routes/admin/users.ts:102`](src/routes/admin/users.ts:102)                    |
| Admin user create                                  | ✅ Complete    | ✅ Complete     | [`UserCreateModal.vue`](frontend/src/components/admin/UserCreateModal.vue)          |
| Admin user disable/enable                          | ✅ Complete    | ✅ Complete     | ban/unban via BetterAuth                                                            |
| Force MFA for user                                 | ✅ Complete    | ✅ Complete     | `isMfaRequired` field                                                               |
| Admin dashboard                                    | ✅ Complete    | 🐛 Broken       | Endpoint exists; frontend reads `data.sessions` but response uses `data.list`       |
| User profile (name, password, avatar)              | ✅ Complete    | ✅ Complete     | [`ProfileView.vue`](frontend/src/views/ProfileView.vue)                             |
| Extended profile fields (phone, company, etc.)     | ✅ Complete    | ✅ Complete     | Additional fields in auth schema                                                    |
| Sessions view (list + revoke)                      | ✅ Complete    | ✅ Complete     | [`SessionsView.vue`](frontend/src/views/SessionsView.vue)                           |
| Subscription view (user-facing)                    | ✅ Complete    | ✅ Complete     | [`SubscriptionView.vue`](frontend/src/views/SubscriptionView.vue)                   |
| MFA settings (TOTP)                                | ✅ Complete    | ✅ Complete     | [`MfaSettingsView.vue`](frontend/src/views/MfaSettingsView.vue)                     |
| MFA settings (passkeys)                            | ✅ Complete    | ✅ Complete     | `@simplewebauthn/browser` used in registration + authentication flows               |
| Integration guide (OAuth code snippets)            | ✅ Complete    | ✅ Complete     | [`AppIntegrationView.vue`](frontend/src/views/admin/AppIntegrationView.vue)         |
| Stripe integration                                 | ⚠️ Partial     | ⚠️ Partial      | Product/price creation works; no webhook handler                                    |
| Social login providers                             | ✅ Complete    | ✅ Complete     | Google + GitHub wired; per-app config via [`AppProvidersTab.vue`](frontend/src/components/admin/AppProvidersTab.vue) |
| Light/dark mode toggle                             | ✅ Complete    | ✅ Complete     | [`AppNav.vue`](frontend/src/components/AppNav.vue) + CSS vars                       |
| i18n (EN + FR)                                     | ✅ Complete    | ✅ Complete     | [`frontend/src/locales/`](frontend/src/locales/)                                    |
| Error code registry                                | ✅ Complete    | ✅ Complete     | [`src/errors.ts`](src/errors.ts)                                                    |
| Docker Compose                                     | ✅ Complete    | ✅ N/A          | [`docker-compose.yml`](docker-compose.yml)                                          |
| TypeScript strict mode                             | ✅ Complete    | ✅ N/A          | `tsconfig.json`                                                                     |
| Unit tests                                         | ⚠️ Partial     | ❌ N/A          | Smoke tests only; no DB integration tests                                           |
| ESLint / Prettier / Husky                          | ❌ Missing     | ❌ Missing      | Not installed                                                                       |

---

## Detailed Analysis

### 1. Authentication & Authorization

#### 1.1 Email + Password

- ✅ **Registration** — `POST /api/auth/sign-up/email` via BetterAuth `emailAndPassword` plugin; min 8 chars enforced ([`src/auth.ts:38`](src/auth.ts:38))
- ✅ **Sign-in** — `POST /api/auth/sign-in/email`; MFA redirect handled in [`LoginView.vue:27`](frontend/src/views/LoginView.vue:27)
- ✅ **Password reset** — `sendResetPassword` hook wired to [`src/services/email.ts`](src/services/email.ts); frontend at [`ResetPasswordView.vue`](frontend/src/views/ResetPasswordView.vue)
- ⚠️ **Email verification** — `requireEmailVerification: false` in [`src/auth.ts:41`](src/auth.ts:41); the hook is wired but the feature is disabled. SPECS.md §3.2 says "optional, configurable" — this is acceptable but should be documented.

#### 1.2 OAuth 2.1 / OIDC

- ✅ **Authorization Code + PKCE flow** — `oauthProvider()` from `@better-auth/oauth-provider` ([`src/auth.ts:109`](src/auth.ts:109))
- ✅ **Discovery endpoints** — `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server` served at root ([`src/index.ts:104`](src/index.ts:104))
- ✅ **JWKS endpoint** — `/api/auth/jwks` served by BetterAuth `jwt()` plugin
- ✅ **Custom claims injection** — `customIdTokenClaims` and `customAccessTokenClaims` hooks call [`getUserClaims()`](src/services/claims.ts)
- ✅ **User access gate** — `customIdTokenClaims` throws `FORBIDDEN` if user has no active `userApplications` record ([`src/auth.ts`](src/auth.ts))
- ✅ **Auto-provision** — on first token exchange for `isPublic` or `allowRegister` apps, a `userApplications` row is inserted and the default role + plan are assigned ([`src/auth.ts`](src/auth.ts), [`src/services/claims.ts`](src/services/claims.ts))
- ✅ **Consent screen** — `/oauth2/consent` route with [`ConsentView.vue`](frontend/src/views/ConsentView.vue)
- ✅ **Refresh tokens** — `offline_access` scope; `oauthRefreshToken` table managed by BetterAuth
- ✅ **`disabledPaths`** — `disabledPaths: ["/token"]` ([`src/auth.ts`](src/auth.ts)) — correct.
- ✅ **App-level MFA enforcement** — `customIdTokenClaims` checks `app.isMfaRequired` and throws `FORBIDDEN` if the user has not enabled 2FA ([`src/auth.ts`](src/auth.ts))

#### 1.3 Session Management

- ✅ **Session listing** — `GET /api/auth/list-sessions` (BetterAuth built-in)
- ✅ **Session revocation** — `POST /api/auth/revoke-session` and `POST /api/auth/revoke-other-sessions`
- ✅ **Frontend** — [`SessionsView.vue`](frontend/src/views/SessionsView.vue) fully implemented

#### 1.4 CORS & Security

- ✅ **CORS** — `@fastify/cors` with configurable origins; manual CORS headers injected for BetterAuth routes ([`src/index.ts:58`](src/index.ts:58))
- ✅ **Cross-subdomain cookies** — `SESSION_DOMAIN` env var support ([`src/auth.ts:26`](src/auth.ts:26))

---

### 2. User Management

#### 2.1 Global Roles

- ✅ **Three-tier roles** — `user`, `admin`, `superadmin` via BetterAuth `admin()` plugin ([`src/auth.ts:73`](src/auth.ts:73))
- ✅ **Role assignment** — `PATCH /api/admin/users/:id` with `{ role }` ([`src/routes/admin/users.ts:165`](src/routes/admin/users.ts:165))
- ✅ **Admin/superadmin bypass** — admins and superadmins bypass app-level access checks (enforced in `customIdTokenClaims`)

#### 2.2 Admin User CRUD

- ✅ **List users** — paginated + search by email ([`src/routes/admin/users.ts:57`](src/routes/admin/users.ts:57))
- ✅ **Create user** — `POST /api/admin/users` ([`src/routes/admin/users.ts:82`](src/routes/admin/users.ts:82))
- ✅ **Get user detail** — includes app access + per-app roles ([`src/routes/admin/users.ts:102`](src/routes/admin/users.ts:102))
- ✅ **Update user** — name, role, isMfaRequired ([`src/routes/admin/users.ts:156`](src/routes/admin/users.ts:156))
- ✅ **Disable/enable** — ban/unban via BetterAuth ([`src/routes/admin/users.ts:186`](src/routes/admin/users.ts:186))
- ✅ **Delete user** — `DELETE /api/admin/users/:id` is implemented ([`src/routes/admin/users.ts`](src/routes/admin/users.ts)); cascades via FK; prevents self-deletion.
- ⚠️ **Last-superadmin guard** — `USR_002` error code is defined but `DELETE /api/admin/users/:id` does not verify that deleting the target would not remove the last superadmin.

#### 2.3 Extended Profile Fields

- ✅ **phone, company, position, address** — added as `additionalFields` in [`src/auth.ts:62`](src/auth.ts:62) and in [`src/db/auth-schema.ts:29`](src/db/auth-schema.ts:29)
- ✅ **Frontend** — [`ProfileView.vue`](frontend/src/views/ProfileView.vue) exposes all fields

#### 2.4 Superadmin Bootstrap

- ✅ **Auto-creation** — [`src/bootstrap.ts`](src/bootstrap.ts) checks for existing superadmin, creates if absent
- ✅ **Warning if env vars missing** — logs warning and skips ([`src/bootstrap.ts:15`](src/bootstrap.ts:15))
- ⚠️ **Role cast** — `role: "superadmin" as "admin"` ([`src/bootstrap.ts:43`](src/bootstrap.ts:43)) is a type cast workaround; BetterAuth's `createUser` type only accepts `"user" | "admin"` but the value `"superadmin"` is passed at runtime. This works but is fragile.

---

### 3. Application Management (OAuth/OIDC)

#### 3.1 Application CRUD

- ✅ **List** — `GET /api/admin/applications` ([`src/routes/admin/applications.ts:145`](src/routes/admin/applications.ts:145))
- ✅ **Create** — transactionally creates `applications` + `oauthClient` rows; returns `clientId` + `clientSecret` once ([`src/routes/admin/applications.ts:154`](src/routes/admin/applications.ts:154))
- ✅ **Get detail** — `GET /api/admin/applications/:id` ([`src/routes/admin/applications.ts:218`](src/routes/admin/applications.ts:218))
- ✅ **Update** — `PATCH /api/admin/applications/:id`; syncs to `oauthClient` table ([`src/routes/admin/applications.ts:229`](src/routes/admin/applications.ts:229))
- ✅ **Delete** — cascades via FK; also removes `oauthClient` row ([`src/routes/admin/applications.ts:263`](src/routes/admin/applications.ts:263))
- ✅ **Rotate secret** — `POST /api/admin/applications/:id/rotate-secret` ([`src/routes/admin/applications.ts:277`](src/routes/admin/applications.ts:277))

#### 3.2 Schema vs SPECS

- ✅ **All required fields present** — `id`, `name`, `slug`, `description`, `isActive`, `skipConsent`, `allowedScopes`, `redirectUris`, `createdAt`, `updatedAt`
- ✅ **Extra fields** — `url`, `icon` added in migration [`drizzle/0001_add_app_url_icon_plan_desc_stripe.sql`](drizzle/0001_add_app_url_icon_plan_desc_stripe.sql) — beyond spec, acceptable
- ⚠️ **`clientId` field** — SPECS.md §2.2 says `clientId` is auto-generated; implementation uses `slug` as `clientId` (stored in `oauthClient.clientId`). This is a deliberate design choice (slug = clientId) documented in code comments. Functionally correct but deviates from spec wording.

#### 3.3 Frontend

- ✅ **Applications list** — [`ApplicationsView.vue`](frontend/src/views/admin/ApplicationsView.vue) with search, sort, pagination
- ✅ **Application detail** — [`ApplicationDetailView.vue`](frontend/src/views/admin/ApplicationDetailView.vue) with sub-section nav
- ✅ **Create modal** — [`AppCreateModal.vue`](frontend/src/components/admin/AppCreateModal.vue) shows credentials once
- ✅ **Edit modal** — [`AppAuthConfigModal.vue`](frontend/src/components/admin/AppAuthConfigModal.vue) with tabbed interface
- ✅ **Delete modal** — [`AppDeleteModal.vue`](frontend/src/components/admin/AppDeleteModal.vue)
- ❌ **`/admin/applications/new` route** — SPECS.md §6.3 lists this route with `ApplicationFormView`; the implementation uses a modal on the list page instead. The route does not exist in [`frontend/src/router/index.ts`](frontend/src/router/index.ts).

---

### 4. Subscription & Plans

#### 4.1 Backend

- ✅ **Plans CRUD** — `GET/POST/PATCH/DELETE /api/admin/applications/:appId/plans` ([`src/routes/admin/plans.ts:72`](src/routes/admin/plans.ts:72))
- ✅ **Plan price tiers** — `POST/DELETE /api/admin/applications/:appId/plans/:planId/prices` ([`src/routes/admin/plans.ts:235`](src/routes/admin/plans.ts:235)) — **beyond spec**
- ✅ **Assign subscription** — `POST /api/admin/applications/:appId/users/:userId/subscription` ([`src/routes/admin/plans.ts:327`](src/routes/admin/plans.ts:327))
- ✅ **Revoke subscription** — `DELETE /api/admin/applications/:appId/users/:userId/subscription` ([`src/routes/admin/plans.ts:392`](src/routes/admin/plans.ts:392))
- ✅ **Default plan auto-assign** — when granting user access (`POST /api/admin/applications/:appId/users`) and on auto-provision at first token exchange ([`src/services/claims.ts`](src/services/claims.ts))
- ✅ **Default role auto-assign** — same trigger points as default plan ([`src/services/claims.ts`](src/services/claims.ts))
- ✅ **Features claim** — `features` scope returns plan's JSON features; empty `{}` if no plan ([`src/services/claims.ts`](src/services/claims.ts))
- ✅ **Expiry check** — expired subscriptions return `{}` for features ([`src/services/claims.ts`](src/services/claims.ts))
- ✅ **`isDefault` uniqueness** — PATCH plan correctly excludes the plan being updated when resetting others to `isDefault = false`, using `ne(subscriptionPlans.id, req.params.planId)` ([`src/routes/admin/plans.ts`](src/routes/admin/plans.ts))

#### 4.2 Stripe Integration

- ✅ **Stripe client** — optional, null if `STRIPE_SECRET_KEY` not set ([`src/services/stripe.ts`](src/services/stripe.ts))
- ✅ **Product creation** — auto-creates Stripe product when creating a plan ([`src/routes/admin/plans.ts:122`](src/routes/admin/plans.ts:122))
- ✅ **Price creation** — creates Stripe price when adding a price tier ([`src/routes/admin/plans.ts:261`](src/routes/admin/plans.ts:261))
- ✅ **Price archival** — archives Stripe price on delete ([`src/routes/admin/plans.ts:316`](src/routes/admin/plans.ts:316))
- ❌ **Stripe webhook handler** — no `POST /stripe/webhook` endpoint; subscription lifecycle events (payment success/failure, cancellation) are not handled
- ❌ **Stripe Checkout / Payment Links** — no checkout flow; billing is admin-managed only

#### 4.3 Frontend

- ✅ **Plans tab** — [`AppSubscriptionsTab.vue`](frontend/src/components/admin/AppSubscriptionsTab.vue) with create/edit/delete
- ✅ **Plan modal** — [`AppPlanModal.vue`](frontend/src/components/admin/AppPlanModal.vue) with features JSON editor and price tiers
- ✅ **Stripe warning banner** — shown when Stripe not configured
- ✅ **User subscription view** — [`SubscriptionView.vue`](frontend/src/views/SubscriptionView.vue) shows plan + features + consumption

---

### 5. MFA (Multi-Factor Authentication)

#### 5.1 TOTP

- ✅ **Enable** — `POST /api/auth/two-factor/enable` with password confirmation
- ✅ **QR code** — TOTP URI returned; frontend generates QR via external API (`api.qrserver.com`) ([`MfaSettingsView.vue:66`](frontend/src/views/MfaSettingsView.vue:66))
- ✅ **Verify** — `POST /api/auth/two-factor/verify-totp`
- ✅ **Backup codes** — returned on first verify; regeneration via `POST /api/auth/two-factor/generate-backup-codes`
- ✅ **Disable** — `POST /api/auth/two-factor/disable`
- ✅ **MFA during login** — `twoFactorRequired: true` response handled in [`LoginView.vue:27`](frontend/src/views/LoginView.vue:27); redirects to [`MfaVerifyView.vue`](frontend/src/views/MfaVerifyView.vue)
- ⚠️ **QR code dependency** — uses external `api.qrserver.com` service; should use a local library (e.g. `qrcode`) for production/offline use

#### 5.2 Passkey / YubiKey

- ✅ **Backend** — `@better-auth/passkey` plugin registered ([`src/auth.ts`](src/auth.ts)); `passkey` table in schema ([`src/db/auth-schema.ts`](src/db/auth-schema.ts))
- ✅ **List passkeys** — `GET /api/auth/passkey/list-user-passkeys`
- ✅ **Delete passkey** — `DELETE /api/auth/passkey/:id`
- ✅ **Registration flow** — [`MfaSettingsView.vue`](frontend/src/views/MfaSettingsView.vue) fetches options from `/api/auth/passkey/generate-register-options`, calls `startRegistration({ optionsJSON })` from `@simplewebauthn/browser`, then posts the serialized attestation to `/api/auth/passkey/register`
- ✅ **Authentication flow** — [`MfaVerifyView.vue`](frontend/src/views/MfaVerifyView.vue) fetches options from `/api/auth/passkey/generate-authenticate-options`, calls `startAuthentication({ optionsJSON })`, then posts the signed assertion to `/api/auth/passkey/verify-authentication`

#### 5.3 Admin Force MFA

- ✅ **Backend** — `PATCH /api/admin/users/:id` with `{ isMfaRequired: true }` ([`src/routes/admin/users.ts`](src/routes/admin/users.ts))
- ✅ **Frontend** — toggle in [`UserDetailView.vue`](frontend/src/views/admin/UserDetailView.vue)
- ⚠️ **Per-user enforcement** — the per-user `isMfaRequired` flag is stored and admin-settable but is not enforced during the sign-in flow. A user with `isMfaRequired: true` who has not set up MFA can still log in.
- ✅ **Per-app enforcement** — the per-application `isMfaRequired` flag is enforced: `customIdTokenClaims` blocks token issuance with `FORBIDDEN` if the app requires MFA and the user has not enabled `twoFactorEnabled` ([`src/auth.ts`](src/auth.ts))

---

### 6. Admin Panel

#### 6.1 Layout & Navigation

- ✅ **Admin layout** — [`AdminLayout.vue`](frontend/src/views/admin/AdminLayout.vue) with sidebar navigation
- ✅ **Route guards** — `requireAdmin` meta in router; redirects non-admins to `/profile` ([`frontend/src/router/index.ts:136`](frontend/src/router/index.ts:136))

#### 6.2 Dashboard

- 🐛 **Sessions panel broken** — [`DashboardView.vue`](frontend/src/views/admin/DashboardView.vue) calls `GET /api/admin/sessions?limit=10` and reads `data.sessions`, but the endpoint ([`src/routes/admin/sessions.ts`](src/routes/admin/sessions.ts)) returns `{ total, list, page, limit }`. Because `data.sessions` is always `undefined`, it falls back to `[]`. The sessions KPI and recent-sessions table always show 0/empty.
  - **Fix**: rename `list` → `sessions` in the endpoint response.
- ✅ **Users KPI** — calls `GET /api/admin/users?page=1&limit=1` — works
- ✅ **Applications KPI** — calls `GET /api/admin/applications` — works
- ✅ **`GET /api/admin/sessions`** — implemented in [`src/routes/admin/sessions.ts`](src/routes/admin/sessions.ts); registered at `/api/admin/sessions` in [`src/index.ts`](src/index.ts)

#### 6.3 Users Management

- ✅ **Users list** — [`UsersView.vue`](frontend/src/views/admin/UsersView.vue) with search, sort, pagination
- ✅ **User detail** — [`UserDetailView.vue`](frontend/src/views/admin/UserDetailView.vue) with role, MFA, ban controls
- ✅ **Create user modal** — [`UserCreateModal.vue`](frontend/src/components/admin/UserCreateModal.vue)
- ⚠️ **User detail shows plan ID not name** — [`UserDetailView.vue:300`](frontend/src/views/admin/UserDetailView.vue:300) shows truncated UUID for subscription plan; should show plan name

#### 6.4 Applications Management

- ✅ **All CRUD operations** — fully implemented with modals
- ✅ **Roles & permissions** — [`AppRolesTab.vue`](frontend/src/components/admin/AppRolesTab.vue) with toggle matrix
- ✅ **Users access** — [`AppUsersTab.vue`](frontend/src/components/admin/AppUsersTab.vue) with role/plan assignment
- ✅ **Plans** — [`AppSubscriptionsTab.vue`](frontend/src/components/admin/AppSubscriptionsTab.vue)
- ✅ **Consumption** — [`AppConsumptionTab.vue`](frontend/src/components/admin/AppConsumptionTab.vue)
- ✅ **Integration guide** — [`AppIntegrationView.vue`](frontend/src/views/admin/AppIntegrationView.vue) with Vue/React/Node snippets

---

### 7. API & Integration

#### 7.1 REST API Completeness vs SPECS.md §7

| Endpoint                                                        | Implemented | Notes                                    |
| --------------------------------------------------------------- | ----------- | ---------------------------------------- |
| `GET /api/admin/applications`                                   | ✅          |                                          |
| `POST /api/admin/applications`                                  | ✅          |                                          |
| `GET /api/admin/applications/:id`                               | ✅          |                                          |
| `PATCH /api/admin/applications/:id`                             | ✅          |                                          |
| `DELETE /api/admin/applications/:id`                            | ✅          |                                          |
| `POST /api/admin/applications/:id/rotate-secret`                | ✅          |                                          |
| `GET /api/admin/applications/:id/roles`                         | ✅          |                                          |
| `POST /api/admin/applications/:id/roles`                        | ✅          |                                          |
| `PATCH /api/admin/applications/:id/roles/:roleId`               | ✅          |                                          |
| `DELETE /api/admin/applications/:id/roles/:roleId`              | ✅          |                                          |
| `GET /api/admin/applications/:id/permissions`                   | ✅          |                                          |
| `POST /api/admin/applications/:id/permissions`                  | ✅          |                                          |
| `DELETE /api/admin/applications/:id/permissions/:permId`        | ✅          |                                          |
| `GET /api/admin/applications/:id/users`                         | ✅          |                                          |
| `POST /api/admin/applications/:id/users`                        | ✅          |                                          |
| `PATCH /api/admin/applications/:id/users/:userId`               | ✅          |                                          |
| `DELETE /api/admin/applications/:id/users/:userId`              | ✅          |                                          |
| `GET /api/admin/users`                                          | ✅          |                                          |
| `GET /api/admin/users/:id`                                      | ✅          |                                          |
| `PATCH /api/admin/users/:id`                                    | ✅          |                                          |
| `POST /api/admin/users/:id/disable`                             | ✅          |                                          |
| `POST /api/admin/users/:id/enable`                              | ✅          |                                          |
| `GET /api/admin/applications/:id/plans`                         | ✅          |                                          |
| `POST /api/admin/applications/:id/plans`                        | ✅          |                                          |
| `PATCH /api/admin/applications/:id/plans/:planId`               | ✅          |                                          |
| `DELETE /api/admin/applications/:id/plans/:planId`              | ✅          |                                          |
| `POST /api/admin/applications/:id/users/:userId/subscription`   | ✅          |                                          |
| `DELETE /api/admin/applications/:id/users/:userId/subscription` | ✅          |                                          |
| `POST /api/consumption`                                         | ✅          |                                          |
| `GET /api/consumption/:userId/:applicationId`                   | ✅          |                                          |
| `GET /api/consumption/:userId/:applicationId/:key`              | ✅          |                                          |
| `DELETE /api/consumption/:userId/:applicationId/:key`           | ✅          |                                          |
| `GET /health`                                                   | ✅          |                                          |
| `GET /.well-known/openid-configuration`                         | ✅          |                                          |
| `GET /.well-known/oauth-authorization-server`                   | ✅          |                                          |
| `GET /api/admin/sessions`                                       | ✅          | Implemented; frontend reads wrong field (`sessions` vs `list`) |
| `DELETE /api/admin/users/:id`                                   | ✅          | Implemented; no last-superadmin guard (`USR_002`)  |

#### 7.2 Error Handling

- ✅ **`ApiError` class** — [`src/errors.ts`](src/errors.ts) with all error codes from SPECS.md §13
- ✅ **Global error handler** — [`src/index.ts`](src/index.ts) catches `ApiError` and Fastify validation errors
- ✅ **`CONS_004`** — correctly defined as "Caller not authorized (requires client_credentials)" with HTTP 403 ([`src/errors.ts`](src/errors.ts)), matching SPECS.md §13
- ⚠️ **`USR_003`** — SPECS.md §13 does not define `USR_003`; code adds it as "Invalid user data" ([`src/errors.ts`](src/errors.ts)) — extra code, not a problem.
- ⚠️ **`ORG_00x` codes** — ORG error codes (ORG_001–ORG_004) exist in [`src/errors.ts`](src/errors.ts) for the organization feature; beyond SPECS.md scope but consistent with the `organization()` plugin in use.

#### 7.3 Consumption Authentication

- ✅ **Bearer token** — `verifyAccessToken` called for `client_credentials` tokens ([`src/routes/consumption.ts`](src/routes/consumption.ts))
- ✅ **Session fallback** — admin/superadmin sessions also accepted ([`src/routes/consumption.ts`](src/routes/consumption.ts))
- ⚠️ **`verifyAccessToken` cast** — uses `(auth.api as any).verifyAccessToken` ([`src/routes/consumption.ts`](src/routes/consumption.ts)) — `any` cast with comment; acceptable per SPECS.md §12.1 exception rule

---

### 8. Infrastructure & DevOps

#### 8.1 Docker

- ✅ **`docker-compose.yml`** — PostgreSQL + auth-service with health check dependency
- ✅ **`docker-compose.dev.yml`** — development variant
- ✅ **`Dockerfile`** — multi-stage build (frontend → TS compile → Alpine runtime)
- ✅ **Auto-migrations** — `runMigrations()` called in production startup ([`src/index.ts:172`](src/index.ts:172))

#### 8.2 TypeScript

- ✅ **`strict: true`** — in `tsconfig.json`
- ⚠️ **`any` usage** — two instances with inline comments ([`src/routes/consumption.ts`](src/routes/consumption.ts), [`src/auth.ts`](src/auth.ts)) — compliant with SPECS.md §12.1 exception rule

#### 8.3 Testing

- ✅ **Unit tests exist** — health, consumption, applications, plans, roles, users, claims all have test files
- ⚠️ **Unit tests are smoke tests only** — all DB calls are mocked; no real DB integration tests
- ✅ **E2E test infrastructure** — Playwright suite under [`tests/e2e/`](tests/e2e/) with Docker Compose stack (postgres, auth-service, seed container, testapp). Scripts: `test:e2e`, `test:e2e:ui`, `test:e2e:docker`
- ❌ **`pnpm test:integration`** — references `vitest.integration.config.ts` which does not exist
- ❌ **Coverage target** — SPECS.md §12.4 requires ≥80% on `src/routes/` and `src/services/`; current tests are too shallow to meet this
- ❌ **BetterAuth plugin hook integration tests** — SPECS.md §12.4 requires integration tests for plugin hooks; none exist (e2e tests cover the auth flow end-to-end but not individual hooks in isolation)

#### 8.4 Linting & Formatting

- ❌ **ESLint** — not installed; SPECS.md §12.5 requires `@typescript-eslint/recommended-type-checked`
- ❌ **Prettier** — not installed
- ❌ **Husky + lint-staged** — not installed; no pre-commit hooks

#### 8.5 Environment Variables

- ✅ **All required vars** — validated with Zod in [`src/config.ts`](src/config.ts)
- ✅ **Optional vars** — SMTP, Stripe, social providers all optional with graceful degradation
- ✅ **`.env.example`** — present at project root
- ✅ **`SESSION_DOMAIN`** — extra var for cross-subdomain cookies; beyond spec, useful

---

## Missing Features (Priority Ordered)

1. **🔴 Dashboard sessions field mismatch** — `GET /api/admin/sessions` is implemented and returns `{ total, list, page, limit }`, but [`DashboardView.vue`](frontend/src/views/admin/DashboardView.vue) reads `data.sessions`. Rename `list` → `sessions` in the endpoint response ([`src/routes/admin/sessions.ts`](src/routes/admin/sessions.ts)), or update the frontend to read `data.list`.

2. **🟠 Integration test suite** — Create `vitest.integration.config.ts` and write real DB integration tests. The `pnpm test:integration` script references a file that does not exist. SPECS.md §12.4 requires ≥80% coverage.

3. **🟠 ESLint + Prettier + Husky** — Install and configure per SPECS.md §12.5. Add `eslint.config.js`, `.prettierrc`, and Husky pre-commit hooks.

4. **🟡 Per-user `isMfaRequired` enforcement** — The per-user flag is admin-settable via `PATCH /api/admin/users/:id` but has no effect on the sign-in flow. Add a BetterAuth hook that checks this field and blocks login or redirects to MFA setup. Note: per-app MFA enforcement is already implemented in `customIdTokenClaims`.

5. **🟡 Stripe webhook handler** — `POST /stripe/webhook` to handle `customer.subscription.updated`, `invoice.payment_failed`, etc. Required for production billing.

6. **🟡 Last-superadmin guard on user deletion** — `DELETE /api/admin/users/:id` is implemented but does not prevent deleting the last superadmin. `USR_002` error code is defined and ready to use.

7. **🟢 `/admin/applications/new` route** — SPECS.md §6.3 lists this route. Currently handled by a modal on the list page; add the route as an alias or dedicated page.

8. **🟢 User detail plan name display** — [`UserDetailView.vue`](frontend/src/views/admin/UserDetailView.vue) shows a truncated UUID for the subscription plan; fetch and display the plan name instead.

9. **🟢 Social providers — LinkedIn, Microsoft, Apple** — Google and GitHub are wired in `auth.ts`. The remaining three providers referenced in `config.ts` can be added to `socialProviders` when their env vars are set.

---

## Broken/Incomplete Features

### 🐛 Critical

1. **Admin dashboard sessions panel** — `GET /api/admin/sessions` is implemented and returns `{ total, list }`. The frontend (`DashboardView.vue`) reads `data.sessions` which is always `undefined`, falling back to `[]`. The sessions KPI and recent-sessions table always display 0/empty.
   - **Fix**: Rename `list` → `sessions` in the `GET /api/admin/sessions` response body in [`src/routes/admin/sessions.ts`](src/routes/admin/sessions.ts).

### 🐛 Non-Critical

2. **Superadmin bootstrap role cast** — [`src/bootstrap.ts`](src/bootstrap.ts) uses `role: "superadmin" as "admin"` to bypass TypeScript type checking. If BetterAuth changes its type definitions, this will silently break.
   - **Fix**: Use a type assertion comment or extend the BetterAuth type to include `"superadmin"`.

3. **Per-user `isMfaRequired` not enforced at login** — The per-user flag is stored and admin-settable but has no effect on the login flow. A user with `isMfaRequired: true` who has not set up MFA can still sign in. (Per-app `isMfaRequired` is enforced at token exchange in `customIdTokenClaims`.)
   - **Fix**: Add a BetterAuth `onRequest` hook or middleware that checks the user's `isMfaRequired` field post-authentication and redirects to MFA setup if needed.

4. **Last-superadmin guard missing from user deletion** — `DELETE /api/admin/users/:id` is implemented but does not verify the target is not the last superadmin. `USR_002` error code exists and is ready to use.
   - **Fix**: Before deleting, count users with `role = 'superadmin'`; if the target is a superadmin and count ≤ 1, throw `ERR.USR_002()`.

---

## Recommended Sprint Plan

### Sprint 1 — Remaining Bug Fixes (1–2 days)

**Goal**: Fix the last broken feature so the service is fully functional.

- [ ] Fix dashboard sessions field mismatch: rename `list` → `sessions` in `GET /api/admin/sessions` response ([`src/routes/admin/sessions.ts`](src/routes/admin/sessions.ts))
- [ ] Add last-superadmin guard to `DELETE /api/admin/users/:id` ([`src/routes/admin/users.ts`](src/routes/admin/users.ts))

### Sprint 2 — Test Coverage (1 week)

**Goal**: Reach ≥80% coverage on `src/routes/` and `src/services/`.

- [ ] Create `vitest.integration.config.ts`
- [ ] Set up test database seeding/teardown utilities
- [ ] Write integration tests for `src/routes/consumption.ts` (happy path + all error paths)
- [ ] Write integration tests for `src/routes/admin/applications.ts`
- [ ] Write integration tests for `src/routes/admin/plans.ts`
- [ ] Write integration tests for `src/routes/admin/roles.ts`
- [ ] Write integration tests for `src/routes/admin/users.ts`
- [ ] Write integration tests for `src/services/claims.ts` (roles, permissions, features claims)
- [ ] Write integration tests for BetterAuth plugin hooks (`customIdTokenClaims` access gate, auto-provision + default role/plan assignment)

### Sprint 3 — Code Quality & Toolchain (3 days)

**Goal**: Meet SPECS.md §12.5 linting requirements.

- [ ] Install and configure ESLint with `@typescript-eslint/recommended-type-checked`
- [ ] Install and configure Prettier
- [ ] Install Husky + lint-staged
- [ ] Fix all ESLint errors (especially `any` usages beyond the allowed exceptions)
- [ ] Add `lint` and `format` scripts to `package.json`

### Sprint 4 — MFA Enforcement & UX Polish (3 days)

**Goal**: Enforce per-user MFA flag; polish minor UX issues.

- [ ] Implement per-user `isMfaRequired` enforcement in login flow (BetterAuth hook or middleware)
- [ ] Fix user detail view to show plan name instead of truncated UUID ([`UserDetailView.vue`](frontend/src/views/admin/UserDetailView.vue))

### Sprint 5 — Extended Features (1 week)

**Goal**: Add remaining features from SPECS.md.

- [ ] Implement Stripe webhook handler (`POST /stripe/webhook`)
- [ ] Add LinkedIn, Microsoft, Apple social providers to `auth.ts` when env vars are set
- [ ] Add `/admin/applications/new` route (or confirm modal approach is acceptable)
- [ ] Add email verification toggle (make `requireEmailVerification` configurable via env var)

### Sprint 6 — Production Hardening (ongoing)

- [ ] Rate limiting on auth endpoints (SPECS.md §13 `AUTH_007`)
- [ ] Structured logging improvements
- [ ] Health check DB connectivity probe (`SRV_002`)
- [ ] Monitoring / alerting setup
- [ ] Security audit (PKCE enforcement, token rotation, CORS review)
