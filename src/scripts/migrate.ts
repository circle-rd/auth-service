import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  MigrationClient,
  applyPlan,
  planMigration,
  type MigrationOptions,
  type MigrationReport,
  type SourceUser,
} from "./migrate-lib.js";
import {
  SOURCES,
  fetchOktaUsers,
  parseAuth0Export,
  parseKeycloakRealm,
  type Source,
} from "./migrate-sources.js";

const USAGE = `Usage: pnpm migrate:<okta|auth0|keycloak> -- [options]

  --apply                 Perform the migration (default: dry run, nothing is written)
  --file <path>           Auth0 user export or Keycloak realm export
  --app <slug>            Grant access to this application; source groups become its roles
  --role-priority a,b,c   Groups in decreasing order of privilege (one role per user)
  --trust-email <bool>    Mark addresses verified (default: true, false for Okta)
  --send-verification     E-mail a verification link to unverified users
  --no-keep-ids           Do not keep the source id as the user id (and token sub)
  --report <path>         Where to write the JSON report

Environment: BETTER_AUTH_URL (also the origin sent with the requests),
AUTH_SERVICE_URL (optional: reach the service at another address), ADMIN_EMAIL,
ADMIN_PASSWORD (a superadmin without a second factor); for Okta also OKTA_ORG_URL and
OKTA_API_TOKEN.`;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const envSchema = z.object({
  BETTER_AUTH_URL: z.string().url(),
  AUTH_SERVICE_URL: z.string().url().optional(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(12),
});
const oktaEnvSchema = z.object({
  OKTA_ORG_URL: z.string().url(),
  OKTA_API_TOKEN: z.string().min(1),
});

const present = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ""),
  );

async function readSource(
  source: Source,
  file: string | undefined,
): Promise<SourceUser[]> {
  if (source === "okta") {
    const env = oktaEnvSchema.parse(present());
    return fetchOktaUsers(env.OKTA_ORG_URL, env.OKTA_API_TOKEN);
  }
  if (!file) throw new Error(`--file is required for ${source}`);
  const text = readFileSync(file, "utf8");
  return source === "auth0" ? parseAuth0Export(text) : parseKeycloakRealm(text);
}

function summarize(report: MigrationReport, plannedRoles: number): void {
  out(`${report.dryRun ? "Dry run: nothing was written." : "Migration done."}`);
  out(`  users to import     ${report.users}`);
  if (!report.dryRun) {
    out(`  imported            ${report.imported}`);
    out(`  failed              ${report.failed}`);
    out(`  roles created       ${report.rolesCreated.length}`);
    out(`  access granted      ${report.granted}`);
  } else {
    out(`  roles from groups   ${plannedRoles}`);
  }
  const byKind = new Map<string, number>();
  for (const issue of report.issues) {
    byKind.set(issue.kind, (byKind.get(issue.kind) ?? 0) + 1);
  }
  for (const [kind, count] of byKind) out(`  ${kind.padEnd(19)} ${count}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      apply: { type: "boolean", default: false },
      file: { type: "string" },
      app: { type: "string" },
      "role-priority": { type: "string" },
      "trust-email": { type: "string" },
      "send-verification": { type: "boolean", default: false },
      "no-keep-ids": { type: "boolean", default: false },
      report: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    out(USAGE);
    return;
  }
  const source = z.enum(SOURCES).parse(positionals[0]);

  const options: MigrationOptions = {
    keepIds: !values["no-keep-ids"],
    trustEmail: z
      .enum(["true", "false"])
      .default(source === "okta" ? "false" : "true")
      .transform((v) => v === "true")
      .parse(values["trust-email"]),
    sendVerification: values["send-verification"],
    appSlug: values.app,
    rolePriority: (values["role-priority"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };

  const users = await readSource(source, values.file);
  const plan = planMigration(users, options);
  out(`${source}: ${users.length} users read`);

  let report: MigrationReport = {
    dryRun: true,
    source,
    users: plan.rows.length,
    imported: 0,
    failed: 0,
    rolesCreated: [],
    granted: 0,
    issues: plan.issues,
    errors: [],
  };

  if (values.apply) {
    const env = envSchema.parse(present());
    const client = new MigrationClient(
      env.AUTH_SERVICE_URL ?? env.BETTER_AUTH_URL,
      new URL(env.BETTER_AUTH_URL).origin,
    );
    await client.signIn(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    try {
      report = await applyPlan(client, plan, { ...options, source });
    } finally {
      await client.signOut();
    }
  }

  summarize(report, plan.roleMembers.size);
  const path =
    values.report ??
    (values.apply
      ? `migration-report-${source}-${Date.now()}.json`
      : undefined);
  if (path) {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    out(`Report written to ${path}`);
  }
  if (report.failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
