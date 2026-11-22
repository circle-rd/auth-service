# Changelog

All notable changes to auth-service are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
