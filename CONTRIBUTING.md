# Contributing to auth-service

> This document defines the development standards for `auth-service`. These rules apply to all contributors and are enforced before any code is merged.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Development Environment](#2-development-environment)
3. [Language and Naming](#3-language-and-naming)
4. [TypeScript Standards](#4-typescript-standards)
5. [Code Quality Gates](#5-code-quality-gates)
6. [Architecture and Structure](#6-architecture-and-structure)
7. [Error Handling](#7-error-handling)
8. [Testing](#8-testing)
9. [Database and Migrations](#9-database-and-migrations)
10. [API Design](#10-api-design)
11. [Security](#11-security)
12. [Versioning and Breaking Changes](#12-versioning-and-breaking-changes)
13. [Git Workflow](#13-git-workflow)

---

## 1. Project Overview

`auth-service` is a self-hosted OAuth 2.1 / OIDC Identity Provider built on **Fastify** + **BetterAuth v1.5+**. It manages users, applications, subscriptions, RBAC, MFA, and passkeys across all CIRCLE downstream services.

**Stack:**

| Layer        | Technology                              |
| ------------ | --------------------------------------- |
| Runtime      | Node.js 22 (ESM)                        |
| Framework    | Fastify 5                               |
| Auth         | BetterAuth + `@better-auth/oauth-provider` |
| ORM          | Drizzle ORM + PostgreSQL 17             |
| Validation   | Zod                                     |
| Frontend     | Vue 3 + Vite + Tailwind v4              |
| Testing      | Vitest + Supertest                      |
| Package mgr  | pnpm                                    |
| Container    | Docker multi-stage (Node 22 Alpine)     |

---

## 2. Development Environment

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker + Docker Compose (for the database)
- A `.env` file based on the required variables in `src/config.ts`

### Setup

```bash
# Start the database
docker compose -f docker-compose.dev.yml up -d

# Install dependencies
pnpm install

# Run migrations
pnpm db:migrate

# Start the dev server (hot-reload)
pnpm dev
```

### Available Scripts

| Command                   | Purpose                               |
| ------------------------- | ------------------------------------- |
| `pnpm dev`                | Dev server with hot-reload (tsx watch) |
| `pnpm build`              | Compile TS + build Vue frontend        |
| `pnpm build:server`       | Compile TS only                        |
| `pnpm build:frontend`     | Build Vue frontend only                |
| `pnpm test`               | Run all unit tests                     |
| `pnpm test:watch`         | Watch mode                             |
| `pnpm test:integration`   | Integration tests (requires DB)        |
| `pnpm db:generate`        | Generate Drizzle migration files       |
| `pnpm db:migrate`         | Apply pending migrations               |
| `pnpm lint`               | Run ESLint                             |
| `pnpm format`             | Run Prettier                           |

---

## 3. Language and Naming

**All code, comments, variable names, interface names, error messages, and documentation must be written in English.** No exceptions, including inline comments.

### Naming Conventions

| Construct         | Convention         | Example                          |
| ----------------- | ------------------ | -------------------------------- |
| Variables         | `camelCase`        | `userId`, `appSlug`              |
| Functions         | `camelCase`        | `requireAdmin`, `getUserClaims`  |
| Types / Interfaces| `PascalCase`       | `UserClaims`, `ApiErrorBody`     |
| Zod schemas       | `camelCase` + `Schema` suffix | `createAppSchema`      |
| Constants         | `SCREAMING_SNAKE_CASE` | `PERMISSION_RE`              |
| Error codes       | `DOMAIN_NNN` pattern | `AUTH_001`, `APP_003`          |
| DB tables         | `snake_case`       | `user_applications`              |
| DB columns        | `snake_case`       | `is_active`, `created_at`        |
| TS identifiers    | `camelCase`        | `isActive`, `createdAt`          |
| Route files       | `kebab-case`       | `stripe-webhook.ts`              |

### Comments

- Write comments to explain **why**, not **what**.
- Remove commented-out dead code. If something is temporarily disabled, open a ticket and add a `// TODO(ticket): reason` reference.
- Section headers use the established `// ── Title ──` separator style already used in this codebase.

---

## 4. TypeScript Standards

### Strict Mode

`tsconfig.json` has `"strict": true` enabled and this must not be weakened. All strict checks apply:

- `strictNullChecks`
- `noImplicitAny`
- `strictFunctionTypes`
- `strictPropertyInitialization`

### `any` is banned

**Do not use `any`.** Use `unknown` and narrow the type explicitly. Use specific types, generics, or mapped types.

```typescript
// ✗ Forbidden
const data: any = JSON.parse(body);

// ✓ Correct
const data: unknown = JSON.parse(body);
if (typeof data !== "object" || !data) throw new Error("Unexpected payload");
```

The only acceptable use of `any` is in third-party type interop where the type is genuinely unrepresentable and it must be isolated, clearly commented, and reviewed on a case-by-case basis.

### Type Centralisation

- Types shared across multiple files belong in a dedicated types file (e.g. `src/types.ts` or co-located `types.ts` within a domain folder).
- Inline one-off types are acceptable only when they are never reused.
- Export types with `export type { … }` to make intent explicit.
- Do not duplicate type definitions. If two routes need the same shape, extract a shared type.

### Zod for Runtime Validation

All external input (HTTP request bodies, query params, environment variables) must be validated with **Zod** before use. The validated type flows from the schema — do not cast the raw input.

```typescript
const body = createAppSchema.parse(req.body);
// body is now fully typed — no casting needed
```

---

## 5. Code Quality Gates

All of the following must pass before a commit is merged:

1. **TypeScript compilation** — `pnpm build:server` must succeed with zero errors.
2. **Linting** — `pnpm lint` must produce zero errors. Warnings should be zero in new code.
3. **Formatting** — `pnpm format --check` must pass. Run `pnpm format` to auto-fix.
4. **Tests** — `pnpm test` must pass with **≥80% line coverage** on `src/routes/**` and `src/services/**`.

These gates are enforced by `lint-staged` + `husky` pre-commit hooks. They cannot be bypassed with `--no-verify` without explicit team approval.

### Toolchain (to be installed)

```bash
pnpm add -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier husky lint-staged
```

ESLint config must include:
- `@typescript-eslint/no-explicit-any` — **error**
- `@typescript-eslint/consistent-type-imports` — **error**
- `no-console` — **warn** (use `fastify.log` in route/service context)

---

## 6. Architecture and Structure

### Directory Layout

```
src/
├── config.ts          # Environment validation and typed config object
├── auth.ts            # BetterAuth instance (single export: `auth`)
├── bootstrap.ts       # One-time startup logic (superadmin seeding)
├── migrate.ts         # Drizzle migration runner
├── errors.ts          # ApiError class + ERR code registry
├── index.ts           # Fastify server bootstrap and route registration
├── db/
│   ├── index.ts       # Drizzle client singleton
│   ├── schema.ts      # Custom application schema (business tables)
│   └── auth-schema.ts # BetterAuth-generated schema (do not edit manually)
├── routes/
│   ├── health.ts
│   ├── user.ts        # Authenticated user-facing routes
│   ├── consumption.ts
│   ├── stripe-webhook.ts
│   └── admin/         # Admin-only routes (require admin/superadmin role)
│       ├── applications.ts
│       ├── plans.ts
│       ├── roles.ts
│       ├── users.ts
│       ├── sessions.ts
│       ├── services.ts
│       └── organizations.ts
└── services/
    ├── claims.ts      # OIDC claims builder
    ├── email.ts       # Transactional email
    ├── stripe.ts      # Stripe integration
    └── templates.ts   # HTML template rendering
```

### Separation of Concerns

| Layer      | Responsibility                                              | Must NOT contain              |
| ---------- | ----------------------------------------------------------- | ----------------------------- |
| `routes/`  | HTTP contract: validate input, call services, send response | Business logic, DB queries    |
| `services/`| Business logic and external integrations                    | HTTP types, reply handling    |
| `db/`      | Schema definitions, migrations, DB client                   | Business logic                |
| `config.ts`| Env parsing and typed config                                | Anything else                 |
| `errors.ts`| Error codes and `ApiError` factory                          | Business logic                |

Routes should delegate to services for all non-trivial logic. A route handler that reaches 50 lines is a signal to extract to a service function.

### File Size Limits

- **Target: ≤500 lines per file.** This is the default expectation.
- **Hard limit: 1000 lines.** A file exceeding 1000 lines must be split before merge. No exceptions.
- When a file grows, split by sub-domain, not by layer. For example, split `applications.ts` into `applications.ts` + `application-users.ts` rather than creating an `applications-helpers.ts`.

### No Code Duplication

- Middleware used in more than one route file (e.g. `requireAdmin`, `requireSession`) must live in a shared `src/middleware.ts` or a `src/middleware/` directory.
- Any utility used more than once must be extracted. Do not copy-paste.
- Schema fragments used across multiple Zod schemas must be defined once and composed.

---

## 7. Error Handling

### Fail Fast

This codebase follows a **fail-fast** philosophy. Do not write defensive code that silently swallows errors or falls back to ambiguous defaults.

```typescript
// ✗ Defensive — hides the problem
const value = config.someKey ?? "default";

// ✓ Fail-fast — forces explicit configuration
const value = config.someKey; // Zod in config.ts already guarantees it is present
```

- Missing configuration is caught at startup by `config.ts` Zod validation and crashes the process immediately with a clear error.
- Unexpected states (a DB row that should exist but does not) throw an `ApiError`, not a silent degradation.
- Do not catch exceptions just to re-throw a generic error. Let the error propagate with its original context or re-throw with added context.

### ApiError and ERR Registry

All HTTP errors must use `ApiError` via the `ERR` registry defined in `src/errors.ts`.

```typescript
// ✓ Use the ERR registry
throw ERR.APP_002();        // Application not found
throw ERR.USR_001();        // User not found
throw ERR.APP_001("Custom message", { field: "slug" });
```

Adding a new error code:
1. Choose the correct domain prefix (`AUTH_`, `APP_`, `PERM_`, `SUB_`, `CONS_`, `USR_`, `ORG_`).
2. Take the next sequential number in that domain.
3. Add an entry in `src/errors.ts` following the existing pattern.
4. Document the new code in `SPECS.md` error code table.

Do **not** create ad-hoc `Error` objects or call `reply.status(xxx).send({ error: "..." })` directly in routes. Always go through `ERR`.

### Fastify Error Hook

The global `onError` hook in `src/index.ts` handles `ApiError` instances and serialises them via `toJSON()`. Unhandled errors result in a 500 with a generic message. This means route handlers do not need individual try/catch blocks unless they need specific recovery logic.

---

## 8. Testing

### Philosophy

Tests should verify **behaviour**, not implementation details. Test the HTTP contract (status codes, response shape, side effects) — not that a specific function was called.

### Structure

Each route file must have a co-located test file (`*.test.ts`). Test files for services live alongside the service file.

```
src/routes/admin/plans.ts        → src/routes/admin/plans.test.ts
src/services/claims.ts           → src/services/claims.test.ts
```

### Writing Tests

- Use `vi.mock()` with `vi.hoisted()` for module-level mocks.
- Spin up a `Fastify` instance per `describe` block using `app.inject()` — do not use Supertest for unit tests.
- Assert on `statusCode`, `headers`, and parsed `body` — not on internal state.
- Integration tests (in `vitest.integration.config.ts`) use a real PostgreSQL database and must clean up after themselves.

```typescript
describe("Admin — plansRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(plansRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("returns 401 when not authenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/applications/x/plans" });
    expect(res.statusCode).toBe(401);
  });
});
```

### Coverage Thresholds

Configured in `vitest.config.ts`:
- `src/routes/**` — ≥80% line coverage
- `src/services/**` — ≥80% line coverage

Coverage drops below threshold block the CI pipeline.

---

## 9. Database and Migrations

### Schema Ownership

- `src/db/schema.ts` — all custom business tables. Edit freely.
- `src/db/auth-schema.ts` — drizzle definitions of every table consumed by
  BetterAuth (core + plugins). **Do not regenerate blindly with
  `pnpm db:generate`** — the columns must stay aligned with the BetterAuth
  plugin schema in use (see `node_modules/better-auth/dist/plugins/<plugin>/schema.mjs`).
  When upgrading `better-auth` or enabling a new plugin, diff the plugin
  schema against `auth-schema.ts` and add any new fields manually, then
  generate the migration with `pnpm db:generate`. Forgetting a column causes
  the drizzle adapter to silently drop it from the `UPDATE … SET` clause and
  produce a `42601 syntax error at or near "where"` at runtime.

### Migrations

1. Modify the schema in `src/db/schema.ts` (or `src/db/auth-schema.ts` for
   BetterAuth-owned tables — see above).
2. Run `pnpm db:generate` to produce a new migration file in `drizzle/`.
3. Review the generated SQL before committing.
4. Run `pnpm db:migrate` to apply locally.
5. Commit the migration file alongside the schema change in the same PR.

Never modify an existing migration file that has already been applied to any
environment. Add a new migration instead.

> **Pre-production exception** — until the first production deployment, the
> consolidated baseline `0000_initial_schema.sql` is treated as malleable: a
> column added during this period may be inlined into the baseline rather
> than shipped as a delta. Doing so requires (a) deleting any post-baseline
> migrations + their snapshots in `drizzle/meta/`, (b) re-running
> `pnpm db:generate` so drizzle-kit produces a fresh `0000_snapshot.json`
> matching the schema TS, and (c) recreating every deployed database from
> scratch. **After the first production deploy this is forbidden** —
> migrations become immutable history.

### Migration runner and history reconciliation

`src/migrate.ts` runs before the Fastify server boots and reconciles the
`drizzle.__drizzle_migrations` history table with the on-disk journal. Two
legacy states are handled automatically:

1. **Pre-consolidation history** — the table contains hashes that no longer
   exist on disk (older, pre-`0000_initial_schema` files). The runner resets
   the table to the consolidated baseline, then lets `migrate()` apply the
   remaining deltas.

2. **Out-of-band DDL** — a column or table created by `db:push` or a manual
   `ALTER` outside the migrator. Each post-baseline migration that may have
   leaked into a deployed environment registers a *probe* in
   `POST_BASELINE_PROBES` (a SQL query that returns a row iff the migration
   is effectively applied). The runner marks every probe-positive migration
   as applied so `migrate()` skips it instead of replaying its DDL and
   crashing on duplicates.

**Whenever you ship a migration that may already exist out-of-band in any
deployed environment**, add a probe entry in `POST_BASELINE_PROBES`. Probes
should be cheap (`information_schema` lookups) and unambiguous — prefer
detecting a column the migration introduces over checking an enum value.

### Query Style

- Use Drizzle's typed query builder. Never use raw SQL strings (`sql\`...\``) unless absolutely necessary, and explain why in a comment.
- Always specify the exact columns you need with `.select({ … })` rather than selecting all columns with `.select()` — this reduces payload size and avoids accidental field exposure.
- Prefer a single query with joins over N+1 queries in a loop.

---

## 10. API Design

### Route Registration

Routes are registered as **Fastify plugins** (async functions accepting `FastifyInstance`). Every route module exports a single named async function.

```typescript
export async function myRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/path", handler);
}
```

### Input Validation

All route bodies and query parameters must be validated with Zod at the top of the handler before any business logic runs.

```typescript
fastify.post("/items", async (req, reply) => {
  const body = createItemSchema.parse(req.body);
  // body is typed — proceed with clean data
});
```

### Response Shape

- Success responses: return data directly as a JSON object. No envelope wrapper unless required by an existing contract.
- Error responses: always use `ApiError.toJSON()` → `{ error: { code, message, details? } }`.
- Use appropriate HTTP status codes. Do not return 200 for errors.

### Admin Routes

All routes under `src/routes/admin/` require `admin` or `superadmin` role. The `requireAdmin` middleware must be attached via `fastify.addHook("preHandler", requireAdmin)` at plugin level, not per route.

---

## 11. Security

### Authentication and Authorisation

- Never trust request data without validation.
- Session verification uses BetterAuth's `auth.api.getSession()` with `fromNodeHeaders()`. Do not implement custom session logic.
- Role checks must be explicit. The presence of a session alone does not grant admin access.
- Passwords, secrets, and tokens are never logged or included in error responses. The `details` field of `ApiError` must not contain sensitive values.

### Secrets

- Never hardcode secrets, API keys, or passwords in source code.
- All secrets are read from environment variables and validated by `config.ts` at startup.
- Client secrets are hashed before storage (SHA-256 base64url as used in BetterAuth's default hasher).

### Input Handling

- All user input flows through Zod schemas before reaching business logic.
- SQL injection is prevented by Drizzle's parameterised query builder. Never concatenate user input into query strings.
- Redirect URIs for OAuth clients are validated against the registered `redirectUris` list. Do not redirect to arbitrary URLs.

### Dependencies

- Keep dependencies up to date. Review changelogs for security advisories before upgrading.
- Do not add a new dependency for functionality that can be implemented in a few lines of idiomatic TypeScript.
- Prefer well-maintained packages from the existing stack over introducing new ones.

---

## 12. Versioning and Breaking Changes

This project follows **Semantic Versioning** (`MAJOR.MINOR.PATCH`).

| Change type          | Version bump | Required action                              |
| -------------------- | ------------ | -------------------------------------------- |
| Bug fix, no API change | `PATCH`    | Changelog entry                              |
| New feature, backward-compatible | `MINOR` | Changelog entry + SPECS.md update     |
| Breaking change     | `MAJOR`      | See below                                    |

### Breaking Changes

A breaking change is anything that alters the public contract:
- Removing or renaming an API endpoint
- Changing request/response shape
- Changing error code semantics
- Removing a database column used by downstream services

**The rule: no backward compatibility shims.** When a breaking change is necessary:

1. Bump the `MAJOR` version in `package.json`.
2. Document the change clearly in the `CHANGELOG.md` with a migration note.
3. Update `SPECS.md` to reflect the new contract.
4. Remove the old implementation entirely. Do not keep a `v1/` legacy path or a deprecated alias alongside the new code.

Downstream services are responsible for updating to the new contract. They are informed by the major version bump and the changelog. This keeps the codebase clean and eliminates double-implementation overhead.

---

## 13. Git Workflow

### Branch Naming

| Type          | Pattern                            | Example                        |
| ------------- | ---------------------------------- | ------------------------------ |
| Feature       | `feat/<short-description>`         | `feat/register-flow`           |
| Bug fix       | `fix/<short-description>`          | `fix/mfa-redirect`             |
| Refactor      | `refactor/<short-description>`     | `refactor/middleware-extract`  |
| Chore / infra | `chore/<short-description>`        | `chore/update-drizzle`         |
| Breaking      | `breaking/<short-description>`     | `breaking/v2-api-contracts`    |

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <subject>

[optional body]

[optional footer: BREAKING CHANGE, Closes #issue]
```

Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `build`, `ci`.

Examples:
```
feat(register): add per-app allowRegister gate
fix(claims): prevent null dereference on missing app slug
refactor(middleware): extract requireAdmin to shared middleware module
test(plans): add 401 and 403 coverage for admin routes
```

### Pull Request Checklist

Before opening a PR, verify:

- [ ] `pnpm build:server` passes with zero TypeScript errors
- [ ] `pnpm lint` passes with zero errors
- [ ] `pnpm format --check` passes
- [ ] `pnpm test` passes with coverage ≥80%
- [ ] New routes have co-located test files
- [ ] No `any` introduced without justification comment
- [ ] No dead code left behind
- [ ] `SPECS.md` updated if the API contract changed
- [ ] Migration file included if DB schema changed
- [ ] Breaking changes bump the major version and have a changelog entry
