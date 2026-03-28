# auth-service — Functional Specifications

> Self-hosted OAuth 2.1 / OIDC Identity Provider built on BetterAuth v1.5+.  
> Single source of truth for users, applications, subscriptions, roles, and MFA.  
> All downstream projects authenticate against this service via standard OAuth 2.1 Authorization Code + PKCE flow.

**Plugin decision**: uses `oauthProvider` from `@better-auth/oauth-provider` (separate package, OAuth 2.1 + OIDC compatible, successor to the built-in `oidcProvider` which is deprecated).

---

## 1. Technology Stack

| Layer                | Choice                                            | Rationale                                                         |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Runtime              | Node.js (ESM)                                     | Same stack as mcp-central                                         |
| Framework            | Fastify                                           | Same stack as mcp-central                                         |
| Auth framework       | `better-auth` v1.5+                               | Plugin-first, BetterAuth base package                             |
| OAuth 2.1 / OIDC     | `@better-auth/oauth-provider` — `oauthProvider()` | Separate package, successor to deprecated built-in `oidcProvider` |
| JWT signing          | `jwt()` plugin from `better-auth/plugins`         | Required by `oauthProvider` for asymmetric token signing          |
| Passkey / YubiKey    | `@better-auth/passkey`                            | FIDO2/WebAuthn, YubiKey-compatible                                |
| TOTP (Auth app)      | `twoFactor()` from `better-auth/plugins`          | Google Authenticator, Authy, Bitwarden                            |
| Admin / global roles | `admin()` from `better-auth/plugins`              | Role management (superadmin/admin/user)                           |
| DB ORM               | Drizzle ORM + PostgreSQL                          | Same stack as mcp-central                                         |
| Frontend (bundled)   | Vue 3 + Vite + Tailwind v4                        | SPA embedded in the service                                       |
| Testing              | Vitest + Supertest                                | Unit tests + HTTP integration tests                               |
| Containerisation     | Docker (Node Alpine multi-stage)                  | Build frontend → compile TS → Alpine runtime                      |

---

## 2. Core Concepts

### 2.1 Users

A user has a **global role** in the auth-service:

| Role         | Description                                                                         |
| ------------ | ----------------------------------------------------------------------------------- |
| `superadmin` | Accès complet à tout. Créé automatiquement au bootstrap. Ne peut pas être supprimé. |
| `admin`      | Gestion des utilisateurs et des applications.                                       |
| `user`       | Accès aux applications autorisées uniquement.                                       |

Un utilisateur peut avoir un seul rôle global, et des rôles supplémentaires **par application** (voir section 4).

### 2.2 Applications

An **application** is a client project consuming auth-service as its OAuth 2.1 / OIDC IdP.

Fields:

- `id` — UUID
- `name` — Display name (e.g. "MCP Central")
- `slug` — URL-safe identifier (e.g. `mcp-central`)
- `description` — Optional description
- `clientId` — Auto-generated, used in the OIDC flow
- `clientSecret` — OIDC secret (hashed in DB, shown once at creation)
- `redirectUrls` — Allowed callback URLs (PKCE flow)
- `isActive` — Global enable/disable
- `allowedScopes` — OIDC scopes allowed (`openid profile email roles permissions features`)
- `skipConsent` — Skip consent screen for trusted first-party apps
- `createdAt`, `updatedAt`

### 2.3 User ↔ Application Access

A user can only access an application if **explicitly authorized** (admins and superadmins bypass this check and have access to all apps).

Fields of the `userApplication` relation:

- `userId`, `applicationId`
- `isActive` — Can suspend access without deleting the relation
- `subscriptionPlanId` — References the active plan for this user in this app (optional; null = free/no plan)
- `createdAt`

### 2.4 RBAC — Per-Application Roles and Permissions

Each application defines its own **roles**, each role holding a set of **permissions** in dot notation.

#### Permission Model

Permissions are represented as `resource.action` or just `resource`:

```
tenants          → read access to the tenants namespace
tenants.write    → write access to the tenants namespace
endpoints        → read
endpoints.write  → write
tools            → read
admin.users      → admin read on users
admin.users.write
```

Available **actions**: `read` (default when not specified) and `write`.

#### Structure

```
AppRole
  id, applicationId, name (e.g. "viewer", "operator", "admin")

AppPermission
  id, applicationId, resource (dot-notation string), action ("read"|"write")

AppRolePermission (join table)
  roleId, permissionId

UserAppRole (user's role within an application)
  userId, applicationId, roleId
```

A user can have **one or more roles per application** (permissions are the union of all assigned roles).

#### OIDC Token Claims Injection

When a user authenticates via the OAuth 2.1 flow (scopes `roles`, `permissions`, or `features` requested), the following custom claims are injected via the `customIdTokenClaims` and `customUserInfoClaims` hooks of `oauthProvider`:

```json
{
  "sub": "uuid-user",
  "email": "user@example.com",
  "name": "Alice",
  "roles": ["operator"],
  "permissions": ["tenants", "tenants.write", "endpoints", "tools"],
  "features": {
    "maxAgents": 5,
    "analytics": true,
    "exportCsv": false,
    "apiCallsPerMonth": 10000
  }
}
```

These claims are populated by querying the `userAppRoles`, `appRolePermissions`, and `userSubscriptions` tables for the OAuth client's matching application.

### 2.5 Subscriptions & Features

A **subscription plan** defines a named set of features for an application. Features are stored as an arbitrary JSON object — the schema is defined per-application.

```
SubscriptionPlan
  id, applicationId
  name (e.g. "free", "pro", "enterprise")
  features: jsonb        // { maxAgents: 5, analytics: true, exportCsv: false }
  isDefault: boolean     // auto-assigned to new users if true
  createdAt, updatedAt

UserSubscription (active subscription per user per app — also tracked in userApplication.subscriptionPlanId)
  id
  userId, applicationId, planId
  expiresAt: timestamp | null    // null = lifetime
  isActive: boolean
  createdAt, updatedAt
```

#### Features Claim in Tokens

When the scope `features` is requested, the `features` JSON (`SubscriptionPlan.features`) of the user's active plan is included in the `id_token` and `/oauth2/userinfo` response. This allows client apps to configure access gates without a round-trip to the auth-service after login.

If the user has no subscription, `features` is an empty object `{}`.

### 2.6 Consumption Tracking

Usage-based consumption events (e.g. API calls, storage used, messages sent) are recorded per user per application. This enables server-side enforcement of plan limits.

```
ConsumptionEntry
  id
  userId, applicationId
  key: string            // e.g. "apiCalls", "storageMb", "messagesSent"
  value: number          // delta (positive = consume, negative = credit)
  recordedAt: timestamp

ConsumptionAggregate (materialized per userId + applicationId + key, refreshed on write)
  userId, applicationId, key
  total: number
  updatedAt
```

The consumption endpoint is authenticated via the OAuth 2.1 `client_credentials` grant — only trusted backend services (not browser clients) call it directly.

---

## 3. Authentication — Supported Flows

### 3.1 Main Flow: Authorization Code + PKCE

Used by all client frontends (Vue.js SPAs):

```
1. Frontend → GET /oauth2/authorize?client_id=...&redirect_uri=...&code_challenge=...&scope=openid profile email roles permissions features
2. auth-service → redirect to /login (auth-service embedded UI)
3. User: email + password (+ MFA if enabled)
4. auth-service → redirect callback to redirect_uri?code=...
5. Frontend → POST /oauth2/token { code, code_verifier }
6. auth-service → { access_token, id_token, refresh_token }
   id_token payload includes: sub, email, name, roles, permissions, features
7. Frontend → GET /oauth2/userinfo (Bearer access_token) → full profile + roles + permissions + features
```

The `features` claim is only populated when the scope `features` is included in the authorization request.

### 3.2 Email + Password

- Registration: email, name, password (min 8 chars)
- Sign-in: email + password
- Email verification (optional, configurable)
- Password reset via email

### 3.3 Refresh Token

- Silent renew via refresh token grant (`offline_access` scope)
- Refresh tokens are hashed in the database (`oauthRefreshToken` table managed by `oauthProvider`)

---

## 4. MFA (Multi-Factor Authentication)

### 4.1 Principle

- MFA enabled **optionally by the user** from their profile
- Once enabled, applies to **all applications** the user has access to
- An admin can force MFA activation for a user
- Multiple factors can be registered simultaneously

### 4.2 TOTP — Authenticator App

Plugin: `twoFactor()` from `better-auth/plugins`

- Compatible with Google Authenticator, Authy, Bitwarden Authenticator
- Activation: QR code generation (TOTP URI), first code verification
- Backup codes generated and encrypted at activation
- Can be disabled from the user profile

### 4.3 Passkey / YubiKey

Plugin: `@better-auth/passkey`

- Protocol: **FIDO2 / WebAuthn** (compatible with all YubiKey 5+, third-party FIDO2 keys)
- Usable as:
  - **Second factor** (after email/password) — replaces TOTP
  - **Primary authentication** (passwordless) — optional, configurable by admin
- Multiple hardware keys can be registered per user
- Each key can be named (e.g. "YubiKey desk", "YubiKey backup")
- Individual keys can be revoked

### 4.4 MFA Flow during Login

```
POST /api/auth/sign-in/email
  → If MFA enabled: response { twoFactorRequired: true }
  → Frontend redirects to /verify-mfa
  → User selects factor (TOTP code OR YubiKey touch)
  → POST /api/auth/two-factor/verify-totp OR /api/auth/passkey/authenticate
  → Session created → OAuth 2.1 flow continues
```

---

## 5. Superadmin Bootstrap

At service startup, if no `superadmin` user exists in the DB:

1. Read `ADMIN_EMAIL` and `ADMIN_PASSWORD` from environment variables
2. Create the user with `role: "superadmin"` via `auth.api.createUser()`
3. Log a confirmation message (password never logged)
4. The superadmin has access to all applications even if absent from `userApplication`

If variables are not set → warning in logs, normal startup (superadmin must be created manually via admin API).

---

## 6. User Interface (Embedded Vue.js SPA)

### 6.1 Public Pages

| Route              | Component            | Description                                           |
| ------------------ | -------------------- | ----------------------------------------------------- |
| `/login`           | `LoginView`          | Email + password, link to /register, forgot password  |
| `/register`        | `RegisterView`       | Registration (email, name, password)                  |
| `/forgot-password` | `ForgotPasswordView` | Password reset request by email                       |
| `/reset-password`  | `ResetPasswordView`  | New password (URL token)                              |
| `/verify-mfa`      | `MfaVerifyView`      | TOTP code entry or YubiKey prompt                     |
| `/oauth2/consent`  | `ConsentView`        | OIDC authorization screen (when `skipConsent: false`) |

### 6.2 Protected Pages — User Space

| Route                   | Component          | Description                                         |
| ----------------------- | ------------------ | --------------------------------------------------- |
| `/profile`              | `ProfileView`      | Name, email, change password                        |
| `/profile/mfa`          | `MfaSettingsView`  | Enable/disable MFA, manage TOTP and hardware keys   |
| `/profile/sessions`     | `SessionsView`     | Active sessions, revocation                         |
| `/profile/subscription` | `SubscriptionView` | Current plan, features summary, consumption metrics |

### 6.3 Protected Pages — Admin / Superadmin Space

| Route                                 | Component               | Description                                                  |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `/admin`                              | `AdminLayout`           | Admin navigation                                             |
| `/admin/users`                        | `UsersView`             | Paginated list + search, quick actions                       |
| `/admin/users/:id`                    | `UserDetailView`        | Profile, global role, app access, per-app roles, force MFA   |
| `/admin/applications`                 | `ApplicationsView`      | List of registered OAuth apps                                |
| `/admin/applications/new`             | `ApplicationFormView`   | Create an app (slug, redirectUrls, scopes, skipConsent)      |
| `/admin/applications/:id`             | `ApplicationDetailView` | Edit, view clientId/secret, manage roles/permissions/plans   |
| `/admin/applications/:id/roles`       | `AppRolesView`          | CRUD roles + dot-notation permissions                        |
| `/admin/applications/:id/users`       | `AppUsersView`          | Users with access, per-user enable/disable + role assignment |
| `/admin/applications/:id/plans`       | `AppPlansView`          | CRUD subscription plans + features JSON editor               |
| `/admin/applications/:id/consumption` | `ConsumptionView`       | Consumption aggregates per user per key                      |

### 6.4 Design System

The auth-service UI adopts the **portal** project theme from the workspace, with added light-mode support.

#### Colors and Backgrounds

```css
/* Dark mode (default) — from portal */
--bg-primary: #09090b; /* zinc-950 */
--bg-secondary: #18181b; /* zinc-900 */
--bg-card: rgba(255, 255, 255, 0.03);
--border: rgba(255, 255, 255, 0.06);
--border-hover: rgba(255, 255, 255, 0.1);
--text-primary: #ffffff;
--text-muted: rgba(255, 255, 255, 0.5);

/* Light mode — .light class on <html> */
--bg-primary: #fafafa;
--bg-secondary: #f4f4f5;
--bg-card: rgba(0, 0, 0, 0.02);
--border: rgba(0, 0, 0, 0.08);
--border-hover: rgba(0, 0, 0, 0.14);
--text-primary: #09090b;
--text-muted: rgba(9, 9, 11, 0.55);
```

#### Typography

- **Sans-serif**: `Inter` (weights 300–700) via Google Fonts
- **Monospace**: `JetBrains Mono` (weights 300–500) — used for tokens, clientId, code blocks

#### Accent Gradients

- Primary: `bg-gradient-to-r from-cyan-400 to-teal-400` (headings, active nav underline)
- Hover glow: `from-cyan-400/10 to-teal-400/10`

#### Card Pattern (from portal `InfraCard`)

```html
<div
  class="border border-[--border] rounded-xl p-6
            hover:border-[--border-hover]
            transition-all duration-300 overflow-hidden
            group relative">
  <!-- hover gradient overlay -->
  <div
    class="absolute inset-0 opacity-0 group-hover:opacity-[0.03]
              bg-gradient-to-br from-cyan-400 to-teal-400
              transition-opacity duration-300" />
  <!-- content -->
</div>
```

#### Navigation (glassmorphism on scroll)

```css
background: rgba(9, 9, 11, 0.8); /* dark */
background: rgba(250, 250, 250, 0.85); /* light */
backdrop-filter: blur(24px);
border-bottom: 1px solid rgba(255, 255, 255, 0.05);
```

#### Status / Category Badges

```
running    → text-emerald-400/70  bg-emerald-500/10  border-emerald-500/15
warning    → text-yellow-400/70   bg-yellow-500/10   border-yellow-500/15
error      → text-red-400/70      bg-red-500/10      border-red-500/15
inactive   → text-gray-400/70     bg-gray-500/10     border-gray-500/15
```

#### Icon Library: `lucide-vue-next` (Vue port of lucide-react used in portal)

#### Animations: `@vueuse/motion` or inline CSS `transition-*` — no heavy animation libraries

#### Light-mode Toggle

A toggle button in the navigation bar writes `"light"` to `localStorage` and toggles the `light` class on `<html>`. System preference is read at mount via `prefers-color-scheme`.

---

## 7. REST API (beyond BetterAuth endpoints)

The following endpoints complement the standard BetterAuth routes (`/api/auth/*`):

### 7.1 Applications (admin)

```
GET    /api/admin/applications                     List all apps
POST   /api/admin/applications                     Create an app
GET    /api/admin/applications/:id                 Detail
PATCH  /api/admin/applications/:id                 Update (name, redirectUrls, isActive, skipConsent)
DELETE /api/admin/applications/:id                 Delete
POST   /api/admin/applications/:id/rotate-secret   Rotate clientSecret
```

### 7.2 Roles and Permissions per App (admin)

```
GET    /api/admin/applications/:id/roles                     List roles
POST   /api/admin/applications/:id/roles                     Create a role
PATCH  /api/admin/applications/:id/roles/:roleId             Update
DELETE /api/admin/applications/:id/roles/:roleId             Delete

GET    /api/admin/applications/:id/permissions               List permissions
POST   /api/admin/applications/:id/permissions               Create (resource + action)
DELETE /api/admin/applications/:id/permissions/:permId       Delete
```

### 7.3 User Access per App (admin)

```
GET    /api/admin/applications/:id/users                     Users with access
POST   /api/admin/applications/:id/users                     Grant access { userId, roleId? }
PATCH  /api/admin/applications/:id/users/:userId             { isActive, roleId }
DELETE /api/admin/applications/:id/users/:userId             Revoke access
```

### 7.4 User Management (admin)

```
GET    /api/admin/users                 Paginated list + search
GET    /api/admin/users/:id             Profile + apps + MFA status + subscription
PATCH  /api/admin/users/:id             { name, role, isMfaRequired }
POST   /api/admin/users/:id/disable     Disable account
POST   /api/admin/users/:id/enable      Re-enable account
```

### 7.5 Subscription Plans (admin)

```
GET    /api/admin/applications/:id/plans             List plans
POST   /api/admin/applications/:id/plans             Create a plan { name, features: object, isDefault }
PATCH  /api/admin/applications/:id/plans/:planId     Update
DELETE /api/admin/applications/:id/plans/:planId     Delete (only if no active subscriptions)

POST   /api/admin/applications/:id/users/:userId/subscription   Assign plan { planId, expiresAt? }
DELETE /api/admin/applications/:id/users/:userId/subscription   Remove subscription
```

### 7.6 Consumption Tracking

**Authentication**: OAuth 2.1 `client_credentials` grant (backend service only, not browser clients).

```
POST   /api/consumption
Body:  { applicationId: string, userId: string, key: string, value: number }
Response: { success: true, aggregate: { key: string, total: number } }

GET    /api/consumption/:userId/:applicationId             All aggregates for user+app
GET    /api/consumption/:userId/:applicationId/:key        Single aggregate
DELETE /api/consumption/:userId/:applicationId/:key        Reset a counter (admin only)
```

**Error responses** follow the global error format (see section 12).

**Validation rules**:

- `key`: alphanumeric + dots, max 64 chars, e.g. `"apiCalls"`, `"storage.mb"`
- `value`: finite number, may be negative (credit)
- `userId` + `applicationId`: must exist in `userApplication`

---

### 7.7 Health Check (public)

```
GET    /health      → { status: "ok", version: string }
```

---

## 8. Database Schema

### 8.1 BetterAuth-Managed Tables

The following tables are created and managed **automatically** by BetterAuth plugins. Do not create them manually.

| Table               | Plugin                        | Notes                                                        |
| ------------------- | ----------------------------- | ------------------------------------------------------------ |
| `user`              | core                          | Extended with `role`, `isMfaRequired` via `additionalFields` |
| `session`           | core                          |                                                              |
| `account`           | core                          | For password + passkey credentials                           |
| `verification`      | core                          | Email verification tokens                                    |
| `twoFactor`         | `twoFactor()`                 | TOTP secret + backup codes                                   |
| `passkey`           | `@better-auth/passkey`        | FIDO2 credential per device                                  |
| `oauthClient`       | `@better-auth/oauth-provider` | Previously `oauthApplication` in oidcProvider                |
| `oauthAccessToken`  | `@better-auth/oauth-provider` | Opaque access tokens (when issued)                           |
| `oauthRefreshToken` | `@better-auth/oauth-provider` | Hashed refresh tokens (new in oauthProvider)                 |
| `oauthConsent`      | `@better-auth/oauth-provider` | Per-user per-client consent records                          |

### 8.2 Custom Tables

```sql
-- Registered applications (logical entity linking to oauthClient)
CREATE TABLE applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,   -- matches oauthClient.clientId for lookup
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  skip_consent    BOOLEAN NOT NULL DEFAULT false,
  allowed_scopes  TEXT[] NOT NULL DEFAULT ARRAY['openid','profile','email'],
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- User ↔ application access
CREATE TABLE user_applications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id       UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  subscription_plan_id UUID REFERENCES subscription_plans(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, application_id)
);

-- Roles defined per application
CREATE TABLE app_roles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (application_id, name)
);

-- Permissions defined per application (dot-notation)
CREATE TABLE app_permissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  resource       TEXT NOT NULL,                 -- e.g. "tenants", "endpoints.write"
  action         TEXT NOT NULL DEFAULT 'read',  -- "read" | "write"
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (application_id, resource, action)
);

-- Role ↔ permission join
CREATE TABLE app_role_permissions (
  role_id       UUID NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES app_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- User role within an application
CREATE TABLE user_app_roles (
  user_id        UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  role_id        UUID NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, application_id, role_id)
);

-- Subscription plans per application
CREATE TABLE subscription_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,                -- e.g. "free", "pro", "enterprise"
  features       JSONB NOT NULL DEFAULT '{}', -- arbitrary feature flags/limits
  is_default     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (application_id, name)
);

-- Active subscription per user per app (mirror of user_applications.subscription_plan_id)
CREATE TABLE user_subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  expires_at     TIMESTAMPTZ,               -- null = lifetime
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, application_id)
);

-- Raw consumption events
CREATE TABLE consumption_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,   -- e.g. "apiCalls", "storage.mb"
  value          NUMERIC NOT NULL,
  recorded_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_consumption_entries_user_app ON consumption_entries (user_id, application_id, key);

-- Materialized aggregates (updated on every write)
CREATE TABLE consumption_aggregates (
  user_id        UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  total          NUMERIC NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, application_id, key)
);
```

---

## 9. Environment Variables

```env
# Server
PORT=3001
HOST=0.0.0.0

# BetterAuth
BETTER_AUTH_SECRET=         # 32 random bytes (openssl rand -base64 32)
BETTER_AUTH_URL=            # Public URL of the auth-service, e.g. https://auth.example.com

# Database
DATABASE_URL=               # postgres://user:pass@host:5432/auth_service

# Bootstrap superadmin (auto-created at first startup if absent)
ADMIN_EMAIL=
ADMIN_PASSWORD=

# CORS — allowed origins (client apps)
CORS_ORIGINS=               # e.g. https://app1.example.com,https://app2.example.com

# Email (for verification and password reset)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Optional: Node environment
NODE_ENV=production
```

---

## 10. Extensibility — Adding BetterAuth Plugins

The BetterAuth configuration in `src/auth.ts` is structured to accept additional plugins without modifying core logic:

```ts
// src/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { emailAndPassword, twoFactor, admin, jwt } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
// import { magicLink } from "better-auth/plugins";      // future addition example
// import { genericOAuth } from "better-auth/plugins";   // social login (future)

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: config.betterAuth.secret,
  baseURL: config.betterAuth.url,
  disabledPaths: ["/token"], // /oauth2/token is the correct path
  plugins: [
    jwt(), // required by oauthProvider for asymmetric signing
    emailAndPassword(),
    twoFactor(), // TOTP + backup codes
    passkey(), // FIDO2 / YubiKey
    admin(), // global superadmin/admin/user roles
    oauthProvider({
      loginPage: "/login",
      consentPage: "/oauth2/consent",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "roles",
        "permissions",
        "features",
      ],
      // Inject roles, permissions, and features into id_token
      customIdTokenClaims: async ({ user, scopes }) => {
        return getUserClaims(user, scopes); // looks up DB for roles + permissions + features
      },
      // Same data in /oauth2/userinfo
      customUserInfoClaims: async ({ user, scopes }) => {
        return getUserClaims(user, scopes);
      },
    }),
    // ← any BetterAuth plugin can be added here
  ],
});
```

Plugins added here automatically affect:

- Exposed REST endpoints
- Database schema (via the Drizzle adapter — run `npx auth generate` after changes)
- OIDC claims (if the plugin exposes user data)

---

## 11. Acceptance Criteria

### Core Auth

- [ ] `GET /health` → `{ status: "ok", version }`
- [ ] `GET /.well-known/openid-configuration` returns issuer + JWKS URL + authorize/token endpoints
- [ ] `GET /.well-known/oauth-authorization-server` returns RFC8414-compliant metadata
- [ ] `GET /api/auth/jwks` returns public key in JWKS format
- [ ] Email/password login → redirect_uri with valid OAuth 2.1 code
- [ ] Token exchange: code → `access_token` + `id_token` with `sub`, `email`, `name`, `roles`, `permissions`, `features`
- [ ] mcp-central backend: BetterAuth token accepted by `OidcMiddleware` (JWT verify via JWKS)

### MFA

- [ ] TOTP activation: QR code generated, OTP verified, backup codes provided
- [ ] YubiKey authentication: key registration, login with touch
- [ ] MFA applies to all projects once enabled for a user

### Subscriptions & Features

- [ ] User with `pro` plan: `features` claim in id_token matches plan's feature JSON
- [ ] User with no plan: `features` claim is `{}`
- [ ] Admin can create, update, delete subscription plans
- [ ] Admin can assign/revoke a plan for a user on a given application

### Consumption

- [ ] `POST /api/consumption` authenticated via `client_credentials` records a delta
- [ ] `GET /api/consumption/:userId/:appId` returns correct aggregates
- [ ] Negative value decrements the aggregate (credit)
- [ ] Invalid `key` format or missing `userId`/`applicationId` returns structured error with code

### Administration

- [ ] Bootstrap superadmin: if `ADMIN_EMAIL` set and DB empty → user created and logged
- [ ] Admin UI: CRUD applications, CRUD roles + permissions, user access management, plan management
- [ ] User without access to an app → `permissions: []`, `features: {}` in token → 403 on the app side

### Infrastructure

- [ ] `docker compose up` → service operational in < 30 seconds
- [ ] TypeScript compilation with `strict: true` produces no errors
- [ ] Test suite passes: `pnpm test` (unit + integration)

---

## 12. Development Standards

### 12.1 TypeScript

- `strict: true` in `tsconfig.json` — non-negotiable
- **`any` is forbidden.** Exceptions require an explicit inline comment:
  ```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any — BetterAuth hook type limitation
  const claims = result as Record<string, unknown>;
  ```
- Prefer `unknown` over `any` for untrusted inputs
- Use Zod for all external input validation (API request bodies, environment variables)
- All async functions must have return type annotations

### 12.2 Code Language

- **All code, comments, variable names, and interfaces in English**
- Exception: user-facing UI strings are in the locale files (`locales/en.yml`, `locales/fr.yml`)

### 12.3 Error Handling and i18n Codes

Every error response from the API **must** include a machine-readable `code` for frontend i18n and client-side handling:

```ts
// Error response shape
interface ApiError {
  code: string; // e.g. "AUTH_001" — see section 13
  message: string; // English developer message
  details?: unknown; // optional validation details
}
```

HTTP error responses:

```json
{
  "error": {
    "code": "APP_002",
    "message": "Application not found"
  }
}
```

BetterAuth errors bubble up with their own codes; custom routes must wrap them in the same shape.

### 12.4 Testing

- **Framework**: Vitest (unit tests) + Supertest (HTTP integration tests)
- **Where to test**:
  - Every route handler: at least one happy path + one error path
  - Every service function: unit tests for business logic (RBAC resolution, claims building, consumption write)
  - BetterAuth plugin hooks: integration tests against a test database
- **Naming convention**: `src/**/*.test.ts`
- **Test database**: separate PostgreSQL DB, seeded before each suite, cleaned after
- **Coverage target**: ≥ 80% on `src/routes/` and `src/services/`
- Run with: `pnpm test` (unit) and `pnpm test:integration`

### 12.5 Linting and Formatting

- ESLint with `@typescript-eslint/recommended-type-checked`
- Prettier for formatting
- Pre-commit hooks via `husky` + `lint-staged`

---

## 13. Error Code Registry

Format: `{DOMAIN}_{3-digit number}`

### AUTH — Authentication & Session

| Code     | HTTP | Description                             |
| -------- | ---- | --------------------------------------- |
| AUTH_001 | 401  | Missing or invalid authentication token |
| AUTH_002 | 401  | Token expired                           |
| AUTH_003 | 401  | Invalid credentials (email/password)    |
| AUTH_004 | 401  | MFA required                            |
| AUTH_005 | 401  | Invalid MFA code                        |
| AUTH_006 | 403  | Account disabled                        |
| AUTH_007 | 429  | Too many login attempts, rate limited   |
| AUTH_008 | 400  | Invalid or expired password reset token |
| AUTH_009 | 400  | Password too weak                       |
| AUTH_010 | 409  | Email already registered                |

### APP — Application Management

| Code    | HTTP | Description                                   |
| ------- | ---- | --------------------------------------------- |
| APP_001 | 400  | Invalid application data (validation error)   |
| APP_002 | 404  | Application not found                         |
| APP_003 | 409  | Application slug already exists               |
| APP_004 | 400  | Cannot delete application with active users   |
| APP_005 | 403  | User does not have access to this application |

### PERM — Roles & Permissions

| Code     | HTTP | Description                                  |
| -------- | ---- | -------------------------------------------- |
| PERM_001 | 400  | Invalid permission format (not dot-notation) |
| PERM_002 | 404  | Role not found                               |
| PERM_003 | 404  | Permission not found                         |
| PERM_004 | 409  | Role name already exists in this application |
| PERM_005 | 409  | Permission already defined                   |
| PERM_006 | 400  | Cannot delete role assigned to active users  |

### SUB — Subscriptions

| Code    | HTTP | Description                                |
| ------- | ---- | ------------------------------------------ |
| SUB_001 | 404  | Subscription plan not found                |
| SUB_002 | 409  | User already has an active subscription    |
| SUB_003 | 400  | Plan has active subscribers, cannot delete |
| SUB_004 | 400  | Subscription expired                       |

### CONS — Consumption

| Code     | HTTP | Description                                         |
| -------- | ---- | --------------------------------------------------- |
| CONS_001 | 400  | Invalid key format                                  |
| CONS_002 | 400  | Value must be a finite number                       |
| CONS_003 | 404  | User+application combination not found              |
| CONS_004 | 403  | Caller not authorized (requires client_credentials) |

### USR — User Management (admin)

| Code    | HTTP | Description                     |
| ------- | ---- | ------------------------------- |
| USR_001 | 404  | User not found                  |
| USR_002 | 409  | Cannot delete the superadmin    |
| USR_003 | 400  | Cannot disable your own account |

### SRV — Server / Internal

| Code    | HTTP | Description               |
| ------- | ---- | ------------------------- |
| SRV_001 | 500  | Internal server error     |
| SRV_002 | 503  | Database unavailable      |
| SRV_003 | 400  | Request validation failed |
