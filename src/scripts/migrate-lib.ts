import { z } from "zod";
import type { LegacyHash } from "../services/legacy-password.js";
import { AuthAdminClient } from "./litellm-lib.js";

// ── Source users ──────────────────────────────────────────────────────────────

/** A user of the provider being migrated away from, in a neutral shape. */
export interface SourceUser {
  /** Identifier at the source provider; kept as the token `sub` by default. */
  id: string;
  email: string;
  name: string;
  /** Whether the source vouches for the address. */
  emailVerified: boolean;
  groups: string[];
  passwordHash?: LegacyHash | undefined;
  /** Algorithm of a password hash that cannot be imported. */
  unsupportedHash?: string | undefined;
}

export type IssueKind =
  "invalid-email" | "duplicate-email" | "several-groups" | "unsupported-hash";

export interface MigrationIssue {
  id: string;
  email: string;
  kind: IssueKind;
  detail?: string;
}

export interface MigrationOptions {
  /** Keep the source id as the user id (and the token `sub`). */
  keepIds: boolean;
  /** Mark addresses verified when the source says so (or always, for Okta). */
  trustEmail: boolean;
  /** Send the verification e-mail to users that are not verified. */
  sendVerification: boolean;
  /** Application to grant access to; its roles come from the source groups. */
  appSlug?: string | undefined;
  /** Groups in decreasing order of privilege, for users in several groups. */
  rolePriority: string[];
}

export interface ImportRow {
  id?: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  passwordHash?: LegacyHash;
}

export interface MigrationPlan {
  rows: ImportRow[];
  /** Role name → ids of the users that get it. */
  roleMembers: Map<string, string[]>;
  /** Ids of the users without any group. */
  withoutRole: string[];
  issues: MigrationIssue[];
}

const emailSchema = z.string().trim().email();

/** A role name auth-service accepts (1–64 characters) from a group name. */
export function toRoleName(group: string): string {
  const name = group
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return name || "group";
}

function pickGroup(groups: string[], priority: string[]): string {
  const ranked = priority.map(toRoleName);
  const names = groups.map(toRoleName);
  const best = ranked.find((p) => names.includes(p));
  return best ?? [...names].sort()[0] ?? "";
}

/** Turn source users into import rows, role assignments and a list of issues. */
export function planMigration(
  users: readonly SourceUser[],
  options: MigrationOptions,
): MigrationPlan {
  const rows: ImportRow[] = [];
  const issues: MigrationIssue[] = [];
  const roleMembers = new Map<string, string[]>();
  const withoutRole: string[] = [];
  const seen = new Set<string>();

  for (const user of users) {
    const email = user.email.trim().toLowerCase();
    if (!emailSchema.safeParse(email).success) {
      issues.push({ id: user.id, email, kind: "invalid-email" });
      continue;
    }
    if (seen.has(email)) {
      issues.push({ id: user.id, email, kind: "duplicate-email" });
      continue;
    }
    seen.add(email);

    rows.push({
      ...(options.keepIds ? { id: user.id } : {}),
      name: user.name.trim().slice(0, 100) || email,
      email,
      ...(options.trustEmail && user.emailVerified
        ? { emailVerified: true }
        : {}),
      ...(user.passwordHash ? { passwordHash: user.passwordHash } : {}),
    });

    if (user.unsupportedHash) {
      issues.push({
        id: user.id,
        email,
        kind: "unsupported-hash",
        detail: user.unsupportedHash,
      });
    }

    if (user.groups.length === 0) {
      withoutRole.push(user.id);
      continue;
    }
    if (user.groups.length > 1) {
      issues.push({
        id: user.id,
        email,
        kind: "several-groups",
        detail: user.groups.join(", "),
      });
    }
    const role = pickGroup(user.groups, options.rolePriority);
    roleMembers.set(role, [...(roleMembers.get(role) ?? []), user.id]);
  }
  return { rows, roleMembers, withoutRole, issues };
}

// ── auth-service ──────────────────────────────────────────────────────────────

const importResponseSchema = z.object({
  created: z.number().int(),
  failed: z.number().int(),
  results: z.array(
    z.object({
      email: z.string(),
      status: z.enum(["created", "error"]),
      message: z.string().optional(),
    }),
  ),
});
export type ImportResponse = z.infer<typeof importResponseSchema>;

const createdRoleSchema = z.object({ role: z.object({ id: z.string() }) });

/** The admin API calls a migration needs, on top of the setup-script client. */
export class MigrationClient extends AuthAdminClient {
  async importUsers(
    rows: ImportRow[],
    sendVerification: boolean,
  ): Promise<ImportResponse> {
    const res = await this.expectOk(
      await this.send("/api/admin/users/import", {
        method: "POST",
        json: { users: rows, sendVerification },
      }),
      "User import",
    );
    return importResponseSchema.parse(await res.json());
  }

  async createRole(appId: string, name: string): Promise<string> {
    const res = await this.expectOk(
      await this.send(`/api/admin/applications/${appId}/roles`, {
        method: "POST",
        json: { name },
      }),
      `Create role ${name}`,
    );
    return createdRoleSchema.parse(await res.json()).role.id;
  }

  async bulkGrant(
    appId: string,
    userIds: string[],
    roleId?: string,
  ): Promise<void> {
    await this.expectOk(
      await this.send(`/api/admin/applications/${appId}/users/bulk`, {
        method: "POST",
        json: { userIds, ...(roleId ? { roleId } : {}) },
      }),
      "Bulk access grant",
    );
  }
}

export interface MigrationReport {
  dryRun: boolean;
  source: string;
  users: number;
  imported: number;
  failed: number;
  rolesCreated: string[];
  granted: number;
  issues: MigrationIssue[];
  /** Per-row failures from the import (e-mail and reason, never a secret). */
  errors: { email: string; message: string }[];
}

const IMPORT_BATCH = 500;
const GRANT_BATCH = 1000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Run a plan against an instance: import the users, then roles and access. */
export async function applyPlan(
  client: MigrationClient,
  plan: MigrationPlan,
  options: MigrationOptions & { source: string },
): Promise<MigrationReport> {
  const report: MigrationReport = {
    dryRun: false,
    source: options.source,
    users: plan.rows.length,
    imported: 0,
    failed: 0,
    rolesCreated: [],
    granted: 0,
    issues: plan.issues,
    errors: [],
  };

  if (options.appSlug && !options.keepIds) {
    throw new Error(
      "--app needs the source ids to be kept (drop --no-keep-ids)",
    );
  }

  const present = new Set<string>();
  for (const batch of chunks(plan.rows, IMPORT_BATCH)) {
    const res = await client.importUsers(batch, options.sendVerification);
    report.imported += res.created;
    report.failed += res.failed;
    for (const r of res.results) {
      if (r.status === "created") present.add(r.email);
      else {
        report.errors.push({ email: r.email, message: r.message ?? "" });
        // A user left by an earlier run is already there: give it its access.
        if (/already exists/i.test(r.message ?? "")) present.add(r.email);
      }
    }
  }

  if (!options.appSlug) return report;

  const presentIds = new Set(
    plan.rows.filter((r) => present.has(r.email)).map((r) => r.id),
  );
  const onlyPresent = (ids: string[]) => ids.filter((id) => presentIds.has(id));

  const apps = await client.listApplications();
  const app = apps.find((a) => a.slug === options.appSlug);
  if (!app) throw new Error(`No application with slug "${options.appSlug}"`);

  const existing = new Map(
    (await client.listRoles(app.id)).map((r) => [r.name, r.id]),
  );
  for (const [role, members] of plan.roleMembers) {
    const userIds = onlyPresent(members);
    if (userIds.length === 0) continue;
    let roleId = existing.get(role);
    if (!roleId) {
      roleId = await client.createRole(app.id, role);
      report.rolesCreated.push(role);
    }
    for (const batch of chunks(userIds, GRANT_BATCH)) {
      await client.bulkGrant(app.id, batch, roleId);
      report.granted += batch.length;
    }
  }
  for (const batch of chunks(onlyPresent(plan.withoutRole), GRANT_BATCH)) {
    await client.bulkGrant(app.id, batch);
    report.granted += batch.length;
  }
  return report;
}
