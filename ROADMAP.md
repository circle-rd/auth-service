# Auth Service — Roadmap & Gap Analysis

> Generated: 2026-03-28  
> Based on: full codebase audit vs [`SPECS.md`](SPECS.md)

---

## Executive Summary

The auth-service is **substantially implemented** and covers the majority of the SPECS.md requirements. The backend is well-structured with Fastify + BetterAuth v1.5+, the OAuth 2.1 / OIDC provider is wired up correctly, and the Vue 3 frontend covers all major user-facing flows. The core authentication pipeline (email/password, MFA, passkeys, OAuth 2.1 Authorization Code + PKCE, consent screen, OIDC claims injection) is fully functional.

**Key gaps** are concentrated in:

1. **Test coverage** — tests are minimal smoke tests; no integration tests against a real DB; coverage target of ≥80% is not met
2. **Admin dashboard** — calls a non-existent `/api/admin/sessions` endpoint
3. **Passkey WebAuthn flow** — the frontend sends raw `PublicKeyCredential` objects without the required `@simplewebauthn/browser` serialization
4. **Error code alignment** — `CONS_004` is used in code but not in SPECS.md; `CONS_004` in SPECS.md maps to "Caller not authorized" but the code uses it for "record not found"
5. **Missing linting/formatting toolchain** — ESLint, Prettier, Husky, lint-staged are not installed
6. **Social login providers** — config keys exist but no BetterAuth `socialProvider()` plugins are wired
7. **`/api/admin/sessions` endpoint** — referenced by the dashboard but never implemented
8. **`ApplicationFormView`** — SPECS.md §6.3 lists `/admin/applications/new` with `ApplicationFormView`; the implementation uses a modal instead (functionally equivalent but route is missing)

Overall project completeness: **~80% of SPECS.md requirements are implemented**.

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
| Passkey / YubiKey                                  | ⚠️ Partial     | 🐛 Broken       | Backend OK; frontend missing WebAuthn serialization                                 |
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
| Auto-assign default plan                           | ✅ Complete    | ✅ N/A          | [`src/routes/admin/applications.ts:94`](src/routes/admin/applications.ts:94)        |
| Consumption tracking (POST)                        | ✅ Complete    | ✅ N/A          | [`src/routes/consumption.ts:72`](src/routes/consumption.ts:72)                      |
| Consumption aggregates (GET)                       | ✅ Complete    | ✅ Complete     | Admin + user-facing views                                                           |
| Consumption reset (DELETE, admin)                  | ✅ Complete    | ❌ Missing      | Backend exists; no frontend UI to reset                                             |
| Admin users list + search                          | ✅ Complete    | ✅ Complete     | [`src/routes/admin/users.ts:57`](src/routes/admin/users.ts:57)                      |
| Admin user detail                                  | ✅ Complete    | ✅ Complete     | [`src/routes/admin/users.ts:102`](src/routes/admin/users.ts:102)                    |
| Admin user create                                  | ✅ Complete    | ✅ Complete     | [`UserCreateModal.vue`](frontend/src/components/admin/UserCreateModal.vue)          |
| Admin user disable/enable                          | ✅ Complete    | ✅ Complete     | ban/unban via BetterAuth                                                            |
| Force MFA for user                                 | ✅ Complete    | ✅ Complete     | `isMfaRequired` field                                                               |
| Admin dashboard                                    | ⚠️ Partial     | 🐛 Broken       | Calls non-existent `/api/admin/sessions` endpoint                                   |
| User profile (name, password, avatar)              | ✅ Complete    | ✅ Complete     | [`ProfileView.vue`](frontend/src/views/ProfileView.vue)                             |
| Extended profile fields (phone, company, etc.)     | ✅ Complete    | ✅ Complete     | Additional fields in auth schema                                                    |
| Sessions view (list + revoke)                      | ✅ Complete    | ✅ Complete     | [`SessionsView.vue`](frontend/src/views/SessionsView.vue)                           |
| Subscription view (user-facing)                    | ✅ Complete    | ✅ Complete     | [`SubscriptionView.vue`](frontend/src/views/SubscriptionView.vue)                   |
| MFA settings (TOTP)                                | ✅ Complete    | ✅ Complete     | [`MfaSettingsView.vue`](frontend/src/views/MfaSettingsView.vue)                     |
| MFA settings (passkeys)                            | ⚠️ Partial     | 🐛 Broken       | Registration flow missing WebAuthn serialization                                    |
| Integration guide (OAuth code snippets)            | ✅ Complete    | ✅ Complete     | [`AppIntegrationView.vue`](frontend/src/views/admin/AppIntegrationView.vue)         |
| Stripe integration                                 | ⚠️ Partial     | ⚠️ Partial      | Product/price creation works; no webhook handler                                    |
| Social login providers                             | ❌ Missing     | ❌ Missing      | Config keys exist; no `socialProvider()` plugins                                    |
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
- ✅ **Custom claims injection** — `customIdTokenClaims` and `customUserInfoClaims` hooks call [`getUserClaims()`](src/services/claims.ts:24)
- ✅ **User access gate** — `customIdTokenClaims` throws `FORBIDDEN` if user has no active `userApplication` record ([`src/auth.ts:128`](src/auth.ts:128))
- ✅ **Consent screen** — `/oauth2/consent` route with [`ConsentView.vue`](frontend/src/views/ConsentView.vue)
- ✅ **Refresh tokens** — `offline_access` scope; `oauthRefreshToken` table managed by BetterAuth
- ⚠️ **`disabledPaths`** — SPECS.md says `disabledPaths: ["/token"]`; code has `disabledPaths: ["/token"]` ([`src/auth.ts:37`](src/auth.ts:37)) — correct.

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
- ❌ **Delete user** — SPECS.md §7.4 does not list DELETE, but SPECS.md §13 has `USR_002: Cannot delete the last superadmin` — implies deletion should exist. No `DELETE /api/admin/users/:id` endpoint is implemented.

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
- ✅ **Default plan auto-assign** — when granting user access ([`src/routes/admin/applications.ts:94`](src/routes/admin/applications.ts:94))
- ✅ **Features claim** — `features` scope returns plan's JSON features; empty `{}` if no plan ([`src/services/claims.ts:100`](src/services/claims.ts:100))
- ✅ **Expiry check** — expired subscriptions return `{}` for features ([`src/services/claims.ts:122`](src/services/claims.ts:122))
- ⚠️ **`isDefault` uniqueness** — PATCH plan does not exclude the current plan when resetting `isDefault = false` ([`src/routes/admin/plans.ts:174`](src/routes/admin/plans.ts:174)); the comment acknowledges this but the exclusion is missing — could briefly set all plans to non-default including the one being updated.

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

- ✅ **Backend** — `@better-auth/passkey` plugin registered ([`src/auth.ts:72`](src/auth.ts:72)); `passkey` table in schema ([`src/db/auth-schema.ts:119`](src/db/auth-schema.ts:119))
- ✅ **List passkeys** — `GET /api/auth/passkey/list-user-passkeys`
- ✅ **Delete passkey** — `DELETE /api/auth/passkey/:id`
- 🐛 **Registration flow broken** — [`MfaSettingsView.vue:177`](frontend/src/views/MfaSettingsView.vue:177) calls `navigator.credentials.create({ publicKey: options })` directly and then sends the raw `PublicKeyCredential` object to the server. WebAuthn credentials must be serialized using `@simplewebauthn/browser`'s `startRegistration()` helper before sending. The raw `PublicKeyCredential` is not JSON-serializable and will fail.
- 🐛 **Authentication flow broken** — [`MfaVerifyView.vue:39`](frontend/src/views/MfaVerifyView.vue:39) calls `POST /api/auth/passkey/authenticate` without a request body; the WebAuthn authentication ceremony requires calling `navigator.credentials.get()` with challenge options first, then sending the signed assertion.

#### 5.3 Admin Force MFA

- ✅ **Backend** — `PATCH /api/admin/users/:id` with `{ isMfaRequired: true }` ([`src/routes/admin/users.ts:171`](src/routes/admin/users.ts:171))
- ✅ **Frontend** — toggle in [`UserDetailView.vue:77`](frontend/src/views/admin/UserDetailView.vue:77)
- ⚠️ **Enforcement** — `isMfaRequired` is stored but BetterAuth does not automatically enforce it during login; custom middleware would be needed to check this field and redirect to MFA setup if not configured

---

### 6. Admin Panel

#### 6.1 Layout & Navigation

- ✅ **Admin layout** — [`AdminLayout.vue`](frontend/src/views/admin/AdminLayout.vue) with sidebar navigation
- ✅ **Route guards** — `requireAdmin` meta in router; redirects non-admins to `/profile` ([`frontend/src/router/index.ts:136`](frontend/src/router/index.ts:136))

#### 6.2 Dashboard

- 🐛 **Sessions KPI broken** — [`DashboardView.vue:34`](frontend/src/views/admin/DashboardView.vue:34) calls `GET /api/admin/sessions?limit=10` which does not exist in the backend. The sessions section will always show empty/zero.
- ✅ **Users KPI** — calls `GET /api/admin/users?page=1&limit=1` — works
- ✅ **Applications KPI** — calls `GET /api/admin/applications` — works
- ❌ **`GET /api/admin/sessions`** — endpoint not implemented in backend

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
| `GET /api/admin/sessions`                                       | ❌          | Referenced by dashboard; not implemented |

#### 7.2 Error Handling

- ✅ **`ApiError` class** — [`src/errors.ts`](src/errors.ts) with all error codes from SPECS.md §13
- ✅ **Global error handler** — [`src/index.ts:143`](src/index.ts:143) catches `ApiError` and Fastify validation errors
- ⚠️ **`CONS_004` mismatch** — SPECS.md §13 defines `CONS_004` as "Caller not authorized (requires client_credentials)" with HTTP 403; code defines it as "Consumption record not found" with HTTP 404 ([`src/errors.ts:85`](src/errors.ts:85)). The "caller not authorized" case uses `AUTH_001` instead.
- ⚠️ **`USR_003`** — SPECS.md §13 does not define `USR_003`; code adds it as "Invalid user data" ([`src/errors.ts:92`](src/errors.ts:92)) — extra code, not a problem.

#### 7.3 Consumption Authentication

- ✅ **Bearer token** — `verifyAccessToken` called for `client_credentials` tokens ([`src/routes/consumption.ts:44`](src/routes/consumption.ts:44))
- ✅ **Session fallback** — admin/superadmin sessions also accepted ([`src/routes/consumption.ts:53`](src/routes/consumption.ts:53))
- ⚠️ **`verifyAccessToken` cast** — uses `(auth.api as any).verifyAccessToken` ([`src/routes/consumption.ts:45`](src/routes/consumption.ts:45)) — `any` cast with comment; acceptable per SPECS.md §12.1 exception rule

---

### 8. Infrastructure & DevOps

#### 8.1 Docker

- ✅ **`docker-compose.yml`** — PostgreSQL + auth-service with health check dependency
- ✅ **`docker-compose.dev.yml`** — development variant
- ✅ **`Dockerfile`** — multi-stage build (frontend → TS compile → Alpine runtime)
- ✅ **Auto-migrations** — `runMigrations()` called in production startup ([`src/index.ts:172`](src/index.ts:172))

#### 8.2 TypeScript

- ✅ **`strict: true`** — in `tsconfig.json`
- ⚠️ **`any` usage** — two instances with inline comments ([`src/routes/consumption.ts:44`](src/routes/consumption.ts:44), [`src/auth.ts:125`](src/auth.ts:125)) — compliant with SPECS.md §12.1 exception rule

#### 8.3 Testing

- ⚠️ **Unit tests exist** — health, consumption, applications, plans, roles, users, claims all have test files
- 🐛 **Tests are smoke tests only** — all DB calls are mocked; no real DB integration tests
- ❌ **`pnpm test:integration`** — references `vitest.integration.config.ts` which does not exist
- ❌ **Coverage target** — SPECS.md §12.4 requires ≥80% on `src/routes/` and `src/services/`; current tests are too shallow to meet this
- ❌ **BetterAuth plugin hook tests** — SPECS.md §12.4 requires integration tests for plugin hooks; none exist

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

1. **🔴 `GET /api/admin/sessions` endpoint** — Dashboard is broken without it. Implement a paginated sessions list endpoint using BetterAuth's admin API or direct DB query. Referenced in [`DashboardView.vue:34`](frontend/src/views/admin/DashboardView.vue:34).

2. **🔴 Passkey WebAuthn frontend fix** — [`MfaSettingsView.vue`](frontend/src/views/MfaSettingsView.vue) and [`MfaVerifyView.vue`](frontend/src/views/MfaVerifyView.vue) need `@simplewebauthn/browser` integration for proper credential serialization. The current implementation will fail at runtime.

3. **🟠 Integration test suite** — Create `vitest.integration.config.ts` and write real DB integration tests. The `pnpm test:integration` script is broken. SPECS.md §12.4 requires ≥80% coverage.

4. **🟠 ESLint + Prettier + Husky** — Install and configure per SPECS.md §12.5. Add `eslint.config.js`, `.prettierrc`, and Husky pre-commit hooks.

5. **🟠 `CONS_004` error code alignment** — Fix the mismatch: SPECS.md defines `CONS_004` as "Caller not authorized (403)"; code uses it for "record not found (404)". Rename the existing `CONS_004` to `CONS_005` and add the correct `CONS_004`.

6. **🟡 `isMfaRequired` enforcement** — The field is stored but not enforced during login. Add a BetterAuth hook or middleware that checks `isMfaRequired` and forces MFA setup if the user hasn't configured it.

7. **🟡 Stripe webhook handler** — `POST /stripe/webhook` to handle `customer.subscription.updated`, `invoice.payment_failed`, etc. Required for production billing.

8. **🟡 Delete user endpoint** — `DELETE /api/admin/users/:id` with superadmin protection (error `USR_002`). The error code exists but the endpoint does not.

9. **🟡 QR code local generation** — Replace external `api.qrserver.com` dependency with a local `qrcode` npm package for TOTP QR codes.

10. **🟢 Social login providers** — Wire `socialProvider()` plugins for Google, GitHub, LinkedIn, Microsoft, Apple when their env vars are set. Config keys already exist in [`src/config.ts:33`](src/config.ts:33).

11. **🟢 `/admin/applications/new` route** — SPECS.md §6.3 lists this route. Currently handled by a modal; add the route as an alias or dedicated page.

12. **🟢 User detail plan name display** — [`UserDetailView.vue:300`](frontend/src/views/admin/UserDetailView.vue:300) shows truncated plan UUID; fetch and display plan name instead.

13. **🟢 `isDefault` PATCH bug fix** — [`src/routes/admin/plans.ts:174`](src/routes/admin/plans.ts:174) resets all plans to `isDefault = false` including the one being updated; add `ne(subscriptionPlans.id, req.params.planId)` to the WHERE clause.

---

## Broken/Incomplete Features

### 🐛 Critical

1. **Admin dashboard sessions panel** — `GET /api/admin/sessions` does not exist. The "Active sessions" KPI and "Recent sessions" table in [`DashboardView.vue`](frontend/src/views/admin/DashboardView.vue) will always show 0/empty.
   - **Fix**: Implement `GET /api/admin/sessions` in a new route file or add to `usersRoutes`.

2. **Passkey registration** — [`MfaSettingsView.vue:177`](frontend/src/views/MfaSettingsView.vue:177) passes raw `PublicKeyCredential` to `JSON.stringify()` which produces `{}` (credentials are not JSON-serializable). The server will receive an empty object.
   - **Fix**: Install `@simplewebauthn/browser` and use `startRegistration(options)` → send the result.

3. **Passkey authentication** — [`MfaVerifyView.vue:39`](frontend/src/views/MfaVerifyView.vue:39) calls `POST /api/auth/passkey/authenticate` with no body. The WebAuthn ceremony requires fetching challenge options first, calling `navigator.credentials.get()`, then sending the signed assertion.
   - **Fix**: Use `@simplewebauthn/browser`'s `startAuthentication()` flow.

### 🐛 Non-Critical

4. **`isDefault` plan PATCH** — When updating a plan to `isDefault: true`, all plans (including the one being updated) are first set to `false`, then the update sets it back to `true`. This is correct in outcome but the intermediate state could cause issues under concurrent requests.
   - **Fix**: Add `ne(subscriptionPlans.id, req.params.planId)` to the reset WHERE clause in [`src/routes/admin/plans.ts:178`](src/routes/admin/plans.ts:178).

5. **`CONS_004` error code** — Code uses `CONS_004` for "record not found" but SPECS.md §13 defines it as "Caller not authorized (403)". This is a semantic mismatch that will confuse frontend i18n.
   - **Fix**: Rename existing `CONS_004` → `CONS_005`; add `CONS_004` for the authorization case.

6. **Superadmin bootstrap role cast** — [`src/bootstrap.ts:43`](src/bootstrap.ts:43) uses `role: "superadmin" as "admin"` to bypass TypeScript type checking. If BetterAuth changes its type definitions, this will silently break.
   - **Fix**: Use a type assertion comment or extend the BetterAuth type to include `"superadmin"`.

7. **`isMfaRequired` not enforced** — The field is stored and displayed but has no effect on the login flow. A user with `isMfaRequired: true` who hasn't set up MFA can still log in without MFA.
   - **Fix**: Add a BetterAuth `onRequest` hook or middleware that checks this field post-authentication.

---

## Recommended Sprint Plan

### Sprint 1 — Critical Bug Fixes (1 week)

**Goal**: Fix all broken features so the service is fully functional.

- [ ] Fix passkey registration: install `@simplewebauthn/browser`, update [`MfaSettingsView.vue`](frontend/src/views/MfaSettingsView.vue) registration flow
- [ ] Fix passkey authentication: update [`MfaVerifyView.vue`](frontend/src/views/MfaVerifyView.vue) authentication flow
- [ ] Implement `GET /api/admin/sessions` endpoint (paginated, with user info join)
- [ ] Fix `isDefault` plan PATCH WHERE clause in [`src/routes/admin/plans.ts`](src/routes/admin/plans.ts)
- [ ] Fix `CONS_004` error code alignment in [`src/errors.ts`](src/errors.ts)

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
- [ ] Write integration tests for BetterAuth plugin hooks (customIdTokenClaims access gate)

### Sprint 3 — Code Quality & Toolchain (3 days)

**Goal**: Meet SPECS.md §12.5 linting requirements.

- [ ] Install and configure ESLint with `@typescript-eslint/recommended-type-checked`
- [ ] Install and configure Prettier
- [ ] Install Husky + lint-staged
- [ ] Fix all ESLint errors (especially `any` usages beyond the allowed exceptions)
- [ ] Add `lint` and `format` scripts to `package.json`

### Sprint 4 — MFA Enforcement & UX Polish (3 days)

**Goal**: Make `isMfaRequired` actually enforce MFA; polish minor UX issues.

- [ ] Implement `isMfaRequired` enforcement in login flow (BetterAuth hook or middleware)
- [ ] Replace `api.qrserver.com` with local `qrcode` package for TOTP QR generation
- [ ] Fix user detail view to show plan name instead of UUID
- [ ] Add `DELETE /api/admin/users/:id` endpoint with superadmin protection

### Sprint 5 — Extended Features (1 week)

**Goal**: Add missing features from SPECS.md.

- [ ] Implement Stripe webhook handler (`POST /stripe/webhook`)
- [ ] Wire social login providers (Google, GitHub) when env vars are set
- [ ] Add `/admin/applications/new` route (or confirm modal approach is acceptable)
- [ ] Add email verification toggle (make `requireEmailVerification` configurable via env var)

### Sprint 6 — Production Hardening (ongoing)

- [ ] Rate limiting on auth endpoints (SPECS.md §13 `AUTH_007`)
- [ ] Structured logging improvements
- [ ] Health check DB connectivity probe (`SRV_002`)
- [ ] Monitoring / alerting setup
- [ ] Security audit (PKCE enforcement, token rotation, CORS review)
