import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  member as memberTable,
  oauthClient,
  session as sessionTable,
  user as userTable,
} from "../db/auth-schema.js";
import { userApplications } from "../db/schema.js";
import { listUserOrganizationIds } from "../services/organization-selection.js";
import { bootstrap } from "../bootstrap.js";
import { cleanDb } from "./helpers/db.js";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";

const TEAMS_SCOPE = "organizations:self:manage";
const DAY_MS = 24 * 60 * 60 * 1000;

let handle: AuthServerHandle;

interface Actor {
  id: string;
  cookie: string;
}

let superadmin: Actor;
let alice: Actor;
let bob: Actor;
let carol: Actor;
let dave: Actor;

interface OrganizationRow {
  id: string;
  team: boolean;
  role?: string;
  name: string;
  slug: string;
}

async function api<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await handle.app.inject({
    method,
    url,
    headers,
    payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: res.statusCode,
    body: (res.body ? JSON.parse(res.body) : {}) as T,
  };
}

async function signInAs(
  email: string,
  role: "user" | "superadmin",
): Promise<Actor> {
  const { cookie } = await signUpAndSignIn(handle, {
    email,
    password: "Password123!",
    name: email,
  });
  if (role !== "user") {
    await db.update(userTable).set({ role }).where(eq(userTable.email, email));
  }
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email));
  if (!row) throw new Error(`no user for ${email}`);
  return { id: row.id, cookie };
}

async function createTeam(actor: Actor, name: string) {
  const res = await api<{ organization: OrganizationRow }>(
    "POST",
    "/api/user/organizations",
    { cookie: actor.cookie, body: { name } },
  );
  expect(res.status).toBe(201);
  return res.body.organization;
}

async function createCompany(ownerId: string, name: string): Promise<string> {
  const created = await api<{ organization: { id: string } }>(
    "POST",
    "/api/admin/organizations",
    {
      cookie: superadmin.cookie,
      body: { name, slug: name.toLowerCase().replace(/\s+/g, "-") },
    },
  );
  expect(created.status).toBe(201);
  const id = created.body.organization.id;
  const added = await api("POST", `/api/admin/organizations/${id}/members`, {
    cookie: superadmin.cookie,
    body: { userId: ownerId, role: "owner" },
  });
  expect(added.status).toBe(201);
  return id;
}

async function issueToken(actor: Actor, teamId: string): Promise<string> {
  const res = await api<{ token: string }>(
    "POST",
    `/api/user/organizations/${teamId}/invitation-token`,
    { cookie: actor.cookie },
  );
  expect(res.status).toBe(201);
  return res.body.token;
}

async function join(actor: Actor, token: string) {
  return api<{ organization: OrganizationRow }>(
    "POST",
    "/api/user/organizations/join",
    { cookie: actor.cookie, body: { token } },
  );
}

async function listMine(actor: Actor, query = "") {
  const res = await api<{ organizations: OrganizationRow[] }>(
    "GET",
    `/api/user/organizations${query}`,
    { cookie: actor.cookie },
  );
  expect(res.status).toBe(200);
  return res.body.organizations;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function createTeamsApp(slug: string, teamsEnabled: boolean) {
  const redirectUri = `https://${slug}.example.com/callback`;
  const created = await api<{
    application: { id: string; allowedScopes: string[] };
    clientSecret: string;
  }>("POST", "/api/admin/applications", {
    cookie: superadmin.cookie,
    body: {
      name: slug,
      slug,
      url: `https://${slug}.example.com`,
      redirectUris: [redirectUri],
      allowedResources: [config.betterAuth.url],
      allowedScopes: ["openid", "profile", "email", "offline_access"],
      skipConsent: true,
      teamsEnabled,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    id: created.body.application.id,
    slug,
    secret: created.body.clientSecret,
    redirectUri,
  };
}

async function userBearer(
  actor: Actor,
  app: { slug: string; secret: string; redirectUri: string },
  scope: string,
): Promise<string> {
  const { verifier, challenge } = createPkcePair();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: app.slug,
    redirect_uri: app.redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "teams-test",
    resource: config.betterAuth.url,
  });
  const authorize = await handle.app.inject({
    method: "GET",
    url: `/api/auth/oauth2/authorize?${query.toString()}`,
    headers: { cookie: actor.cookie },
  });
  expect(authorize.statusCode).toBe(302);
  const code = new URL(authorize.headers.location ?? "").searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " +
        Buffer.from(`${app.slug}:${app.secret}`).toString("base64"),
    },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: app.redirectUri,
      code_verifier: verifier,
      client_id: app.slug,
      resource: config.betterAuth.url,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  return (JSON.parse(token.body) as { access_token: string }).access_token;
}

beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
  await bootstrap();
  // Alice creates many teams across the file; the quota is exercised on its own user.
  (config.teams as { maxPerUser: number }).maxPerUser = 1000;
  superadmin = await signInAs("root@example.com", "superadmin");
  alice = await signInAs("alice@example.com", "user");
  bob = await signInAs("bob@example.com", "user");
  carol = await signInAs("carol@example.com", "user");
  dave = await signInAs("dave@example.com", "user");
});

afterAll(async () => {
  await handle.cleanup();
});

describe("team creation", () => {
  it("creates a team owned by the caller with a derived slug", async () => {
    const res = await api<{ organization: OrganizationRow & { slug: string; logo: string | null } }>(
      "POST",
      "/api/user/organizations",
      { cookie: alice.cookie, body: { name: "Acme Team" } },
    );
    expect(res.status).toBe(201);
    expect(res.body.organization).toMatchObject({
      name: "Acme Team",
      team: true,
      role: "owner",
      logo: null,
    });
    expect(res.body.organization.slug).toMatch(/^acme-team-[0-9a-f]{6}$/);
  });

  it("accepts an https logo and gives every team its own server-made slug", async () => {
    const first = await api<{ organization: OrganizationRow & { slug: string; logo: string } }>(
      "POST",
      "/api/user/organizations",
      {
        cookie: alice.cookie,
        body: { name: "Design Lab", logo: "https://cdn.example.com/logo.png" },
      },
    );
    expect(first.status).toBe(201);
    expect(first.body.organization).toMatchObject({
      logo: "https://cdn.example.com/logo.png",
    });

    const twin = await createTeam(alice, "Design Lab");
    expect(twin.slug).toMatch(/^design-lab-[0-9a-f]{6}$/);
    expect(twin.id).not.toBe(first.body.organization.id);
    expect(twin.slug).not.toBe(first.body.organization.slug);
  });

  it("refuses every field a team cannot carry with ORG_003", async () => {
    const forbidden = [
      { domain: "example.com" },
      { verifyDomain: false },
      { autoEnrollEnabled: true },
      { team: false },
      { metadata: { region: "eu" } },
      { createdBy: bob.id },
      { slug: "chosen-by-client" },
    ];
    for (const extra of forbidden) {
      const res = await api("POST", "/api/user/organizations", {
        cookie: alice.cookie,
        body: { name: "Strict Team", ...extra },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "ORG_003" } });
    }
  });

  it("refuses a logo that is not https with ORG_003", async () => {
    const res = await api("POST", "/api/user/organizations", {
      cookie: alice.cookie,
      body: { name: "Plain Logo", logo: "http://example.com/logo.png" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "ORG_003" } });
  });

  it("enforces the per-user quota with ORG_013", async () => {
    const quota = config.teams as { maxPerUser: number };
    const original = quota.maxPerUser;
    quota.maxPerUser = 2;
    try {
      await createTeam(dave, "Quota One");
      await createTeam(dave, "Quota Two");
      const res = await api("POST", "/api/user/organizations", {
        cookie: dave.cookie,
        body: { name: "Quota Three" },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "ORG_013" } });
    } finally {
      quota.maxPerUser = original;
    }
  });
});

describe("listing", () => {
  it("lists memberships and filters them on team", async () => {
    const team = await createTeam(carol, "Filter Team");
    const companyId = await createCompany(carol.id, "Filter Company");

    const all = await listMine(carol);
    expect(all.map((row) => row.id)).toEqual(
      expect.arrayContaining([team.id, companyId]),
    );

    const teamsOnly = await listMine(carol, "?team=true");
    expect(teamsOnly.every((row) => row.team === true)).toBe(true);
    expect(teamsOnly.map((row) => row.id)).toContain(team.id);
    expect(teamsOnly.map((row) => row.id)).not.toContain(companyId);

    const companiesOnly = await listMine(carol, "?team=false");
    expect(companiesOnly.every((row) => row.team === false)).toBe(true);
    expect(companiesOnly.map((row) => row.id)).toContain(companyId);
    expect(companiesOnly.map((row) => row.id)).not.toContain(team.id);
  });

  it("refuses a team filter that is neither true nor false", async () => {
    const res = await api("GET", "/api/user/organizations?team=maybe", {
      cookie: carol.cookie,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "ORG_003" } });
  });

  it("filters the admin listing on team", async () => {
    const team = await createTeam(alice, "Admin Filter Team");
    const companyId = await createCompany(alice.id, "Admin Filter Company");

    const teams = await api<{ organizations: OrganizationRow[] }>(
      "GET",
      "/api/admin/organizations?team=true&limit=100",
      { cookie: superadmin.cookie },
    );
    expect(teams.status).toBe(200);
    expect(teams.body.organizations.every((row) => row.team === true)).toBe(true);
    expect(teams.body.organizations.map((row) => row.id)).toContain(team.id);

    const companies = await api<{ organizations: OrganizationRow[] }>(
      "GET",
      "/api/admin/organizations?team=false&limit=100",
      { cookie: superadmin.cookie },
    );
    expect(companies.body.organizations.every((row) => row.team === false)).toBe(
      true,
    );
    expect(companies.body.organizations.map((row) => row.id)).toContain(companyId);

    const invalid = await api("GET", "/api/admin/organizations?team=maybe", {
      cookie: superadmin.cookie,
    });
    expect(invalid.status).toBe(400);
  });

  it("excludes teams from the organizations an authorization can bind to", async () => {
    const team = await createTeam(bob, "Bound Team");
    const companyId = await createCompany(bob.id, "Bound Company");

    const bound = await listUserOrganizationIds(bob.id);
    expect(bound).toContain(companyId);
    expect(bound).not.toContain(team.id);
  });
});

describe("invitation token and join", () => {
  it("issues a token valid for seven days and redeems it as a member", async () => {
    const team = await createTeam(alice, "Join Team");
    const issued = await api<{ token: string; expiresAt: string }>(
      "POST",
      `/api/user/organizations/${team.id}/invitation-token`,
      { cookie: alice.cookie },
    );
    expect(issued.status).toBe(201);
    expect(
      Math.abs(new Date(issued.body.expiresAt).getTime() - (Date.now() + 7 * DAY_MS)),
    ).toBeLessThan(60_000);

    const joined = await join(bob, issued.body.token);
    expect(joined.status).toBe(201);
    expect(joined.body.organization).toMatchObject({
      id: team.id,
      role: "member",
      team: true,
    });

    const mine = await listMine(bob, "?team=true");
    expect(mine).toContainEqual(expect.objectContaining({ id: team.id, role: "member" }));
  });

  it("refuses a second join of the same team with ORG_005", async () => {
    const team = await createTeam(alice, "Double Join Team");
    const token = await issueToken(alice, team.id);
    expect((await join(carol, token)).status).toBe(201);
    const again = await join(carol, token);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "ORG_005" } });
  });

  it("answers an unknown token with ORG_014 and a malformed request with ORG_003", async () => {
    const unknown = await join(dave, "not-a-real-token");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: "ORG_014" } });

    const malformed = await api("POST", "/api/user/organizations/join", {
      cookie: dave.cookie,
      body: {},
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "ORG_003" } });
  });

  it("revokes the previous token when a new one is issued", async () => {
    const team = await createTeam(alice, "Rotating Team");
    const first = await issueToken(alice, team.id);
    const second = await issueToken(alice, team.id);

    const stale = await join(dave, first);
    expect(stale.status).toBe(404);
    expect(stale.body).toMatchObject({ error: { code: "ORG_014" } });
    expect((await join(dave, second)).status).toBe(201);
  });

  it("revokes the active token on request", async () => {
    const team = await createTeam(alice, "Revoked Team");
    const token = await issueToken(alice, team.id);

    const revoked = await api("DELETE", `/api/user/organizations/${team.id}/invitation-token`, {
      cookie: alice.cookie,
    });
    expect(revoked.status).toBe(204);

    const refused = await join(bob, token);
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: { code: "ORG_014" } });
  });

  it("refuses to issue a token to a non-owner with AUTH_011", async () => {
    const team = await createTeam(alice, "Owner Only Team");
    expect((await join(bob, await issueToken(alice, team.id))).status).toBe(201);

    const res = await api("POST", `/api/user/organizations/${team.id}/invitation-token`, {
      cookie: bob.cookie,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "AUTH_011" } });
  });

  it("refuses to issue a token for a company with ORG_012", async () => {
    const companyId = await createCompany(alice.id, "Token Company");
    const res = await api("POST", `/api/user/organizations/${companyId}/invitation-token`, {
      cookie: alice.cookie,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "ORG_012" } });
  });
});

describe("leave", () => {
  it("lets a member leave and clears the team from the active session", async () => {
    const team = await createTeam(alice, "Leaving Team");
    const token = await issueToken(alice, team.id);
    expect((await join(bob, token)).status).toBe(201);
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: team.id })
      .where(eq(sessionTable.userId, bob.id));

    const left = await api("POST", `/api/user/organizations/${team.id}/leave`, {
      cookie: bob.cookie,
    });
    expect(left.status).toBe(204);

    const remaining = await listMine(bob);
    expect(remaining.map((row) => row.id)).not.toContain(team.id);
    const sessions = await db
      .select({ active: sessionTable.activeOrganizationId })
      .from(sessionTable)
      .where(eq(sessionTable.userId, bob.id));
    expect(sessions.every((row) => row.active === null)).toBe(true);
  });

  it("refuses the last owner with ORG_011", async () => {
    const team = await createTeam(alice, "Sole Owner Team");
    const res = await api("POST", `/api/user/organizations/${team.id}/leave`, {
      cookie: alice.cookie,
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "ORG_011" } });
  });

  it("lets an owner leave once another owner exists", async () => {
    const team = await createTeam(alice, "Shared Ownership Team");
    expect((await join(carol, await issueToken(alice, team.id))).status).toBe(201);
    await db
      .update(memberTable)
      .set({ role: "owner" })
      .where(
        and(
          eq(memberTable.userId, carol.id),
          eq(memberTable.organizationId, team.id),
        ),
      );

    const res = await api("POST", `/api/user/organizations/${team.id}/leave`, {
      cookie: alice.cookie,
    });
    expect(res.status).toBe(204);
  });

  it("refuses to leave a company with ORG_012 and a non-membership with ORG_004", async () => {
    const companyId = await createCompany(bob.id, "Leave Company");
    const company = await api("POST", `/api/user/organizations/${companyId}/leave`, {
      cookie: bob.cookie,
    });
    expect(company.status).toBe(403);
    expect(company.body).toMatchObject({ error: { code: "ORG_012" } });

    const team = await createTeam(alice, "Stranger Team");
    const stranger = await api("POST", `/api/user/organizations/${team.id}/leave`, {
      cookie: dave.cookie,
    });
    expect(stranger.status).toBe(404);
    expect(stranger.body).toMatchObject({ error: { code: "ORG_004" } });
  });
});

describe("application teams flag and bearer scope", () => {
  it("derives the scope from the flag, on the application and its OAuth client", async () => {
    const app = await createTeamsApp("teams-flag-app", true);
    const [enabled] = await db
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, app.slug));
    expect(enabled?.scopes).toContain(TEAMS_SCOPE);

    const disabled = await api<{ application: { allowedScopes: string[] } }>(
      "PATCH",
      `/api/admin/applications/${app.id}`,
      { cookie: superadmin.cookie, body: { teamsEnabled: false } },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.application.allowedScopes).not.toContain(TEAMS_SCOPE);
    const [after] = await db
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, app.slug));
    expect(after?.scopes).not.toContain(TEAMS_SCOPE);
  });

  it("accepts a user token carrying the teams scope and refuses one without it", async () => {
    const app = await createTeamsApp("teams-bearer-app", true);
    await db.insert(userApplications).values({
      userId: alice.id,
      applicationId: app.id,
      isActive: true,
    });

    const withScope = await userBearer(alice, app, `openid ${TEAMS_SCOPE}`);
    const created = await api<{ organization: OrganizationRow }>(
      "POST",
      "/api/user/organizations",
      { bearer: withScope, body: { name: "Bearer Team" } },
    );
    expect(created.status).toBe(201);
    expect(created.body.organization).toMatchObject({ team: true, role: "owner" });

    const listed = await api("GET", "/api/user/organizations", { bearer: withScope });
    expect(listed.status).toBe(200);

    const withoutScope = await userBearer(alice, app, "openid profile");
    const refused = await api("POST", "/api/user/organizations", {
      bearer: withoutScope,
      body: { name: "Refused Team" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "AUTH_011" } });
  });
});
