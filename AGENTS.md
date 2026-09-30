# AGENTS.md — Technical standards for `auth-service`

> Canonical reference for AI coding agents and code reviewers. Every rule here
> is enforced by quality gates, tests, or review. For contributor onboarding
> and Git/PR process, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Build & Test Commands

| Command                  | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `pnpm dev`               | Hot-reload dev server (`tsx watch`)              |
| `pnpm build:server`      | TypeScript compile (must be zero errors)         |
| `pnpm test`              | Unit suite (Vitest, no external services)        |
| `pnpm test:integration`  | Integration suite (spins up PostgreSQL container)|
| `pnpm exec tsc --noEmit` | Type-check only                                  |
| `pnpm db:generate`       | Generate Drizzle migration files                 |
| `pnpm db:migrate`        | Apply pending migrations                         |
| `pnpm lint`              | ESLint                                           |
| `pnpm format`            | Prettier auto-fix                                |

A change is mergeable only when `pnpm build:server`, `pnpm lint`, `pnpm test`
and `pnpm test:integration` all pass.

---

## 1. Project Overview

`auth-service` is a self-hosted OAuth 2.1 / OIDC Identity Provider built on
**Fastify** + **BetterAuth v1.6+**. It manages users, applications,
subscriptions, RBAC, MFA, and passkeys across all CIRCLE downstream services.

| Layer        | Technology                                  |
| ------------ | ------------------------------------------- |
| Runtime      | Node.js 22 (ESM)                            |
| Framework    | Fastify 5                                   |
| Auth         | BetterAuth + `@better-auth/oauth-provider`  |
| ORM          | Drizzle ORM + PostgreSQL 17                 |
| Validation   | Zod                                         |
| Frontend     | Vue 3 + Vite + Tailwind v4                  |
| Testing      | Vitest                                      |
| Package mgr  | pnpm                                        |
| Container    | Docker multi-stage (Node 22 Alpine)         |

---

## 2. Language and Naming

**All code, comments, variable names, interface names, error messages, and
documentation must be written in English.** No exceptions, including inline
comments.

| Construct          | Convention                    | Example                          |
| ------------------ | ----------------------------- | -------------------------------- |
| Variables          | `camelCase`                   | `userId`, `appSlug`              |
| Functions          | `camelCase`                   | `requireAdmin`, `getUserClaims`  |
| Types / Interfaces | `PascalCase`                  | `UserClaims`, `ApiErrorBody`     |
| Zod schemas        | `camelCase` + `Schema` suffix | `createAppSchema`                |
| Constants          | `SCREAMING_SNAKE_CASE`        | `PERMISSION_RE`                  |
| Error codes        | `DOMAIN_NNN` pattern          | `AUTH_001`, `APP_003`            |
| DB tables          | `snake_case`                  | `user_applications`              |
| DB columns         | `snake_case`                  | `is_active`, `created_at`        |
| TS identifiers     | `camelCase`                   | `isActive`, `createdAt`          |
| Route files        | `kebab-case`                  | `stripe-webhook.ts`              |

### Comments

- Explain **why**, not **what**.
- Default to no comment. Add one only when the WHY is non-obvious — a hidden
  constraint, an upstream bug worked around, or behaviour that would surprise
  a reader.
- Keep it to one short line. No multi-paragraph docstrings.
- Never reference the current task or PR ("added for X", "handles case Y") —
  that belongs in the commit/PR description.
- Remove commented-out dead code. Use `// TODO(ticket): reason` for temporary
  exclusions.
- Section headers use the existing `// ── Title ──` separator style.

---

## 3. TypeScript Standards

### Strict mode is mandatory

`tsconfig.json` has `"strict": true` and this must not be weakened.

### `any` is banned

Use `unknown` and narrow explicitly. Use specific types, generics, or mapped
types.

```typescript
// ✗ Forbidden
const data: any = JSON.parse(body);

// ✓ Correct
const data: unknown = JSON.parse(body);
if (typeof data !== "object" || !data) throw new Error("Unexpected payload");
```

The only acceptable use of `any` is in third-party type interop where the
shape is genuinely unrepresentable; it must be isolated and commented.

### Type centralisation

- Types shared across multiple files live in a dedicated `types.ts`
  (top-level or domain-local).
- Inline one-off types are acceptable when never reused.
- Use `export type { … }` to mark intent.
- Do not duplicate type definitions.

### Zod for runtime validation

All external input (HTTP bodies, query params, env vars) is validated with
**Zod** before use. The validated type flows from the schema — do not cast
the raw input.

```typescript
const body = createAppSchema.parse(req.body);
// body is now fully typed — no casting needed
```

---

## 4. Code Quality Gates

1. **TypeScript** — `pnpm build:server` must succeed with zero errors.
2. **Linting** — `pnpm lint` must produce zero errors. Warnings should be
   zero in new code.
3. **Formatting** — `pnpm format --check` must pass.
4. **Tests** — `pnpm test` and `pnpm test:integration` must pass with
   **≥80% line coverage** on `src/routes/**` and `src/services/**`.

Gates are enforced by `lint-staged` + `husky` pre-commit hooks. They cannot
be bypassed with `--no-verify` without explicit team approval.

ESLint configuration requires:
- `@typescript-eslint/no-explicit-any` — **error**
- `@typescript-eslint/consistent-type-imports` — **error**
- `no-console` — **warn** (use `fastify.log` in route/service context)

---

## 5. Architecture and Structure

### Directory layout

```
src/
├── config.ts          # Environment validation and typed config object
├── auth.ts            # BetterAuth instance (single export: `auth`)
├── bootstrap.ts       # One-time startup logic (superadmin seeding)
├── migrate.ts         # Drizzle migration runner
├── errors.ts          # ApiError class + ERR code registry
├── server.ts          # buildServer() — Fastify app factory
├── index.ts           # Process entrypoint (calls buildServer + listen)
├── db/
│   ├── index.ts       # Drizzle client singleton
│   ├── schema.ts      # Custom application schema (business tables)
│   └── auth-schema.ts # BetterAuth-generated schema (see §8)
├── routes/
│   ├── health.ts
│   ├── user.ts
│   ├── consumption.ts
│   ├── stripe-webhook.ts
│   └── admin/         # Admin-only routes
└── services/
    ├── claims.ts      # OIDC claims builder
    ├── email.ts       # Transactional email entry-points
    ├── mail/          # Transport abstraction (SMTP / capture for tests)
    ├── stripe.ts      # Stripe integration
    └── templates.ts   # Email/template rendering
```

### Separation of concerns

| Layer       | Responsibility                                              | Must NOT contain              |
| ----------- | ----------------------------------------------------------- | ----------------------------- |
| `routes/`   | HTTP contract: validate input, call services, send response | Business logic, DB queries    |
| `services/` | Business logic and external integrations                    | HTTP types, reply handling    |
| `db/`       | Schema definitions, migrations, DB client                   | Business logic                |
| `config.ts` | Env parsing and typed config                                | Anything else                 |
| `errors.ts` | Error codes and `ApiError` factory                          | Business logic                |

A route handler that reaches ~50 lines is a signal to extract a service
function.

### File size limits

- **Target ≤ 500 lines per file** — default expectation.
- **Hard limit 1000 lines** — must be split before merge, no exceptions.
- Split by sub-domain, not by layer (`applications.ts` →
  `applications.ts` + `application-users.ts`, not `applications-helpers.ts`).

### No code duplication

- Middleware used in more than one route file lives in `src/middleware.ts`
  (or `src/middleware/`).
- Utilities used more than once must be extracted.
- Schema fragments used across multiple Zod schemas are defined once and
  composed.

---

## 6. Error Handling

### Fail fast

Do not write defensive code that silently swallows errors or falls back to
ambiguous defaults.

```typescript
// ✗ Defensive — hides the problem
const value = config.someKey ?? "default";

// ✓ Fail-fast — Zod in config.ts already guarantees presence
const value = config.someKey;
```

- Missing configuration crashes the process at startup via `config.ts` Zod
  validation.
- Unexpected states (a DB row that should exist) throw an `ApiError`, never a
  silent fallback.
- Do not catch exceptions just to re-throw a generic error. Let it propagate
  or re-throw with added context.

### `ApiError` + `ERR` registry

All HTTP errors must use `ApiError` via the `ERR` registry in
`src/errors.ts`.

```typescript
throw ERR.APP_002();                                    // Application not found
throw ERR.USR_001();                                    // User not found
throw ERR.APP_001("Custom message", { field: "slug" });
```

Adding a new code:
1. Pick the right domain prefix (`AUTH_`, `APP_`, `PERM_`, `SUB_`, `CONS_`,
   `USR_`, `ORG_`, `MAIL_`, `RATE_`, `SRV_`).
2. Take the next sequential number in that domain.
3. Add the entry in `src/errors.ts` following the existing pattern.
4. Document it in `SPECS.md`.

**Never** create ad-hoc `Error` objects or call
`reply.status(xxx).send({ error: "…" })` directly in routes. Always go
through `ERR`.

The global `onError` hook in `src/server.ts` serialises `ApiError` via
`toJSON()`. Unhandled errors return a generic 500. Route handlers should not
wrap every call in try/catch unless they have specific recovery logic.

---

## 7. Testing

### Philosophy

Tests verify **behaviour**, not implementation details. Assert on HTTP
contract (status codes, response shape, side effects) — not on which
internal function was called.

### Structure

- Co-located unit tests: `src/routes/admin/plans.ts` →
  `src/routes/admin/plans.test.ts`.
- Integration tests: `src/tests/*.integration.test.ts`, picked up by
  `vitest.integration.config.ts`.

### Writing tests

- Use `vi.mock()` with `vi.hoisted()` for module-level mocks.
- For unit tests, spin up a Fastify instance per `describe` block and use
  `app.inject()` (no real HTTP port).
- Assert on `statusCode`, `headers`, parsed `body` — not on internal state.
- Integration tests use a real PostgreSQL container (`PostgreSqlContainer`,
  spun up once via `global-setup.ts`) and a `MailCaptureTransport` swapped
  in via `setMailTransport()` before the server is built.
- Always call `cleanDb()` between integration tests; never leak rows across
  cases.

### Coverage thresholds

- `src/routes/**` — ≥ 80 % line coverage
- `src/services/**` — ≥ 80 % line coverage

Coverage below threshold blocks CI.

---

## 8. Database and Migrations

### Schema ownership

- `src/db/schema.ts` — custom business tables. Edit freely.
- `src/db/auth-schema.ts` — Drizzle definitions of every table consumed by
  BetterAuth (core + plugins). **Do not regenerate blindly with
  `pnpm db:generate`** — columns must stay aligned with the BetterAuth
  plugin schema in use (`node_modules/better-auth/dist/plugins/<plugin>/schema.mjs`).

  When upgrading BetterAuth or enabling a new plugin, diff the plugin schema
  against `auth-schema.ts` and add any new fields manually, then generate
  the migration with `pnpm db:generate`. Forgetting a column causes the
  Drizzle adapter to silently drop it from the `UPDATE … SET` clause and
  produce a `42601 syntax error at or near "where"` at runtime.

### Migrations

1. Modify the schema in `src/db/schema.ts` (or `src/db/auth-schema.ts` for
   BetterAuth tables — see above).
2. Run `pnpm db:generate` to produce a new file in `drizzle/`.
3. **Review the generated SQL** before committing.
4. Run `pnpm db:migrate` to apply locally.
5. Commit the migration file alongside the schema change, same PR.

**Never modify an existing migration file that has been applied to any
environment.** Add a new migration instead.

> **Pre-production exception** — until the first production deploy, the
> consolidated baseline `0000_initial_schema.sql` is treated as malleable.
> A column added during this period may be inlined into the baseline
> instead of shipped as a delta. Doing so requires (a) deleting any
> post-baseline migrations + their snapshots in `drizzle/meta/`, (b)
> re-running `pnpm db:generate` so drizzle-kit produces a fresh
> `0000_snapshot.json` matching the schema TS, and (c) recreating every
> deployed database from scratch. **After the first production deploy this
> is forbidden** — migrations become immutable history.

### Migration runner and history reconciliation

`src/migrate.ts` runs before the Fastify server boots and reconciles the
`drizzle.__drizzle_migrations` history table with the on-disk journal. Two
legacy states are handled automatically:

1. **Pre-consolidation history** — the table contains hashes that no longer
   exist on disk. The runner resets to the consolidated baseline, then
   `migrate()` applies the remaining deltas.
2. **Out-of-band DDL** — a column or table created by `db:push` or a manual
   `ALTER`. Each post-baseline migration that may have leaked into a
   deployed environment registers a *probe* in `POST_BASELINE_PROBES` (a
   SQL query returning a row iff the migration is effectively applied).
   Probe-positive migrations are marked as applied so `migrate()` skips
   them.

**Whenever you ship a migration that may already exist out-of-band in any
deployed environment, add a probe entry in `POST_BASELINE_PROBES`.** Probes
should be cheap (`information_schema` lookups) and unambiguous — prefer
detecting a column the migration introduces over checking an enum value.

### Query style

- Use Drizzle's typed query builder. Avoid raw SQL strings (`` sql`...` ``)
  unless absolutely necessary, and explain why in a comment.
- Always specify exact columns with `.select({ … })` — never `.select()`
  alone. Reduces payload size and avoids accidental field exposure.
- Prefer a single query with joins over N+1 queries in a loop.

---

## 9. API Design

### Route registration

Routes are Fastify plugins — async functions accepting `FastifyInstance`.
Every route module exports a single named async function.

```typescript
export async function myRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/path", handler);
}
```

### Input validation

All bodies and query parameters are validated with Zod at the top of the
handler before any business logic.

```typescript
fastify.post("/items", async (req, reply) => {
  const body = createItemSchema.parse(req.body);
  // body is typed — proceed
});
```

### Response shape

- Success: return data directly as a JSON object. No envelope wrapper unless
  required by an existing contract.
- Error: always `ApiError.toJSON()` → `{ error: { code, message, details? } }`.
- Use appropriate HTTP status codes. Never return 200 for errors.

### Admin routes

All routes under `src/routes/admin/` require `admin` or `superadmin` role.
The `requireAdmin` middleware is attached via
`fastify.addHook("preHandler", requireAdmin)` at plugin level — not per
route.

---

## 10. Security

### Authentication and authorisation

- Never trust request data without validation.
- Session verification uses BetterAuth's `auth.api.getSession()` with
  `fromNodeHeaders()`. Do not implement custom session logic.
- Role checks must be explicit. The presence of a session alone does not
  grant admin access.
- Passwords, secrets, OTPs, magic-link tokens, and password-reset tokens are
  **never logged** and never included in error responses. The `details` field
  of `ApiError` must not carry sensitive values.

### Secrets

- Never hardcode secrets, API keys, or passwords in source code.
- All secrets are read from environment variables and validated by
  `config.ts` at startup.
- Client secrets are hashed before storage (SHA-256 base64url, the
  BetterAuth default hasher).

### Input handling

- All user input flows through Zod schemas before reaching business logic.
- SQL injection is prevented by Drizzle's parameterised query builder.
  Never concatenate user input into query strings.
- OAuth redirect URIs are validated against the registered `redirectUris`
  list — never redirect to arbitrary URLs.

### Rate limiting

The Fastify `onRequest` hook in `src/server.ts` applies two dedicated
in-memory buckets to BetterAuth endpoints:

- `AUTH_RATE_PATHS` (sign-in, sign-up, password reset request, etc.) →
  responds with `ERR.RATE_001()` on overflow.
- `EMAIL_SEND_PATHS` (outbound-email endpoints) → responds with
  `ERR.MAIL_003()` on overflow.

New auth endpoints that issue credentials or send mail must be added to the
appropriate bucket.

### Dependencies

- Keep dependencies up to date. Review changelogs for security advisories
  before upgrading.
- Do not add a new dependency for functionality that can be implemented in a
  few lines of idiomatic TypeScript.
- Prefer well-maintained packages from the existing stack over introducing
  new ones.
