# Changelog

All notable changes to auth-service are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- **Application-scoped resources.** An application sees and uses only the resources it owns
  or that were shared with it; no application can list everything a user owns. The database
  baseline `drizzle/0000_initial_schema.sql` is regenerated: existing databases are reset.
- `POST /api/internal/resources/authorize` and `/resources/accessible` take the calling
  application from the machine token. `clientId` is no longer read from the body; an optional
  `actorClientId` is kept for audit only. Denials gain `invalid_client`, `invalid_audience`,
  `not_in_scope` and `insufficient_permission`.
- Bearer user tokens are confined to the application they were issued to on every
  `/api/user/*` resource route; the web session keeps its global view.
- `POST /api/internal/gateway/entitlements` takes `{ token }` and derives the person and the
  application itself (the `userId` route is gone). Answers carry a signed `decisionId`
  (`GATEWAY_DECISION_TTL_S`, default 60 s). `POST /api/internal/gateway/usage` takes
  `decisionId` and `startedAt` instead of `subjectId` and `clientId` (`400 RES_016`).
- LiteLLM resources live in a namespace that follows the owner: `u-<username>` for a user,
  the application slug otherwise. Application slugs can no longer start with `u-`, and the
  first locator segment accepts 65 characters. A username cannot change while the account
  owns resources in its namespace (`409 RES_018`); `preferred_username` no longer falls back
  to the email or the first name.
- `DELETE /api/user/resources/:resourceId` always deletes (`409 RES_019` while the relay
  serves the model); resources are no longer disabled. Grants are cleaned up with their
  resource, user, organisation or application.

### Added

- Grant `permission` (`read` default, `write` covers `read`) on grants, invitations,
  `accessible-resources` and `authorize`; `PATCH …/grants/:grantId`; per-scheme supported
  levels (`400 RES_014`, `409 RES_015`); webhook event `resource.grant.updated`.
- `application` grant subject and `POST /api/user/resource-shares` for bulk sharing.
- `DELETE …/grants/:grantId?permanent=true` (`409 RES_020`), webhook event `resource.deleted`
  and a retention sweep (`RESOURCE_GRANT_RETENTION_DAYS`, default 90).
- System application `catalogue` that owns the models declared by the relay.
- Console: permission levels, application sharing, permanent deletion of grants and resources.

## [0.3.0] - 2026-11-22

### Added

- **Teams**: a user creates a team through `POST /api/user/organizations`, becomes its owner,
  and lists their memberships with `GET /api/user/organizations?team=true|false`. The server
  generates the slug; a team never carries a domain and never auto-enrolls anyone.
- Invitation tokens: an owner issues one with `POST /api/user/organizations/:id/invitation-token`
  (7 days, usable any number of times, shown once, stored as a hash). Anyone redeems it with
  `POST /api/user/organizations/join`. `DELETE` on the same path revokes it.
- `POST /api/user/organizations/:id/leave`. The last owner of a team cannot leave.
- Scope `organizations:self:manage`, granted to an application by its **Teams** option
  (`teamsEnabled`). The console turns the option on with the `org` claim; it can be switched
  off on its own.
- Error codes `ORG_011` (last owner), `ORG_012` (operation reserved to teams), `ORG_013`
  (team quota reached) and `ORG_014` (invitation token not valid).
- `TEAM_MAX_PER_USER` (default `10`) bounds the teams one creator may own.
- `GET /api/admin/organizations?team=true|false` filters the administrator listing.
- Rate limit on team writes (create, join, token issuance): 60 requests per minute per IP.

### Changed

- `GET /api/user/organizations` accepts the `organizations:self:manage` scope as well as
  `resources:self:manage`, and each entry carries a `team` flag.
- Teams never bind the `org_id` claim: only companies do.
- The initial migration baseline was regenerated (pre-production). New columns:
  `organization.team`, `organization.created_by`, `applications.teams_enabled`; new table
  `team_invitation_tokens`.

### Fixed

- The OAuth client's scopes follow the application's Resource sharing flag when the flag
  changes, and at creation. Before, only an explicit `allowedScopes` update was mirrored to the
  OAuth client, so toggling the flag alone could leave the client without the scope.
