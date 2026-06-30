# Contributing to auth-service

> Welcome — this document covers contributor onboarding, environment setup,
> versioning policy, and the Git workflow. **All technical standards**
> (TypeScript, architecture, testing, error handling, database, security)
> live in [AGENTS.md](AGENTS.md) and are the canonical reference. Read both
> documents before opening a PR.

---

## 1. Development Environment

### Prerequisites

- Node.js 22+
- pnpm 10+
- Docker + Docker Compose (for the database)
- A `.env` file populated according to the variables declared in
  `src/config.ts`

### First-time setup

```bash
# Start the database
docker compose -f docker-compose.dev.yml up -d

# Install dependencies
pnpm install

# Apply migrations
pnpm db:migrate

# Start the dev server (hot-reload)
pnpm dev
```

### Daily commands

For the full command table see [AGENTS.md → Build & Test Commands](AGENTS.md#build--test-commands).
The four you will use most often:

| Command                 | When to run                          |
| ----------------------- | ------------------------------------ |
| `pnpm dev`              | Local development                    |
| `pnpm test`             | Before committing                    |
| `pnpm test:integration` | Before opening a PR                  |
| `pnpm db:generate`      | After editing `src/db/schema.ts`     |

---

## 2. Versioning and Breaking Changes

This project follows **Semantic Versioning** (`MAJOR.MINOR.PATCH`).

| Change type                       | Version bump | Required action                       |
| --------------------------------- | ------------ | ------------------------------------- |
| Bug fix, no API change            | `PATCH`      | Changelog entry                       |
| New feature, backward-compatible  | `MINOR`      | Changelog entry + `SPECS.md` update   |
| Breaking change                   | `MAJOR`      | See below                             |

### Breaking changes

A breaking change is anything that alters the public contract:

- Removing or renaming an API endpoint
- Changing request/response shape
- Changing error code semantics
- Removing a database column used by downstream services

**The rule: no backward-compatibility shims.** When a breaking change is
necessary:

1. Bump the `MAJOR` version in `package.json`.
2. Document the change clearly in `CHANGELOG.md` with a migration note.
3. Update `SPECS.md` to reflect the new contract.
4. Remove the old implementation entirely. Do not keep a `v1/` legacy path
   or a deprecated alias alongside the new code.

Downstream services are responsible for updating to the new contract. The
major version bump + changelog entry are how they are notified. This keeps
the codebase clean and eliminates double-implementation overhead.

---

## 3. Git Workflow

### Branch naming

| Type          | Pattern                          | Example                       |
| ------------- | -------------------------------- | ----------------------------- |
| Feature       | `feat/<short-description>`       | `feat/register-flow`          |
| Bug fix       | `fix/<short-description>`        | `fix/mfa-redirect`            |
| Refactor      | `refactor/<short-description>`   | `refactor/middleware-extract` |
| Chore / infra | `chore/<short-description>`      | `chore/update-drizzle`        |
| Breaking      | `breaking/<short-description>`   | `breaking/v2-api-contracts`   |

### Commit messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/)
specification:

```
<type>(<scope>): <subject>

[optional body]

[optional footer: BREAKING CHANGE, Closes #issue]
```

Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `build`,
`ci`.

Examples:

```
feat(register): add per-app allowRegister gate
fix(claims): prevent null dereference on missing app slug
refactor(middleware): extract requireAdmin to shared middleware module
test(plans): add 401 and 403 coverage for admin routes
```

### Pull request checklist

Before opening a PR, verify:

- [ ] `pnpm build:server` passes with zero TypeScript errors
- [ ] `pnpm lint` passes with zero errors
- [ ] `pnpm format --check` passes
- [ ] `pnpm test` passes with coverage ≥ 80 %
- [ ] `pnpm test:integration` passes
- [ ] New routes have co-located test files
- [ ] No `any` introduced without justification comment
- [ ] No dead code left behind
- [ ] `SPECS.md` updated if the API contract changed
- [ ] Migration file included if DB schema changed (and a probe entry added
      in `POST_BASELINE_PROBES` if the DDL may already exist out-of-band)
- [ ] Breaking changes bump the major version and have a changelog entry

For the rationale behind each gate and the standards new code must meet,
see [AGENTS.md](AGENTS.md).
