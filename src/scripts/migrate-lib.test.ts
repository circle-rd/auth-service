import { pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  applyPlan,
  planMigration,
  toRoleName,
  type MigrationClient,
  type MigrationOptions,
  type SourceUser,
} from "./migrate-lib.js";
import {
  fetchOktaUsers,
  parseAuth0Export,
  parseKeycloakRealm,
} from "./migrate-sources.js";

const OPTIONS: MigrationOptions = {
  keepIds: true,
  trustEmail: true,
  sendVerification: false,
  rolePriority: [],
};

const user = (over: Partial<SourceUser> & { id: string }): SourceUser => ({
  email: `${over.id}@example.com`,
  name: over.id,
  emailVerified: true,
  groups: [],
  ...over,
});

describe("toRoleName", () => {
  it("builds a valid role name from a group name", () => {
    expect(toRoleName("Platform Admins")).toBe("platform-admins");
    expect(toRoleName("  /Ops/Tier 2 ")).toBe("ops-tier-2");
    expect(toRoleName("!!!")).toBe("group");
    expect(toRoleName("x".repeat(100))).toHaveLength(64);
  });
});

describe("planMigration", () => {
  it("keeps ids and trusts verified addresses", () => {
    const plan = planMigration([user({ id: "00u1" })], OPTIONS);
    expect(plan.rows).toEqual([
      {
        id: "00u1",
        name: "00u1",
        email: "00u1@example.com",
        emailVerified: true,
      },
    ]);
  });

  it("drops ids and verification when asked to", () => {
    const plan = planMigration([user({ id: "u" })], {
      ...OPTIONS,
      keepIds: false,
      trustEmail: false,
    });
    expect(plan.rows[0]).toEqual({
      name: "u",
      email: "u@example.com",
    });
  });

  it("reports invalid and duplicate e-mails, and skips them", () => {
    const plan = planMigration(
      [
        user({ id: "a", email: "not-an-email" }),
        user({ id: "b", email: "Same@Example.com" }),
        user({ id: "c", email: "same@example.com" }),
      ],
      OPTIONS,
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.issues.map((i) => i.kind)).toEqual([
      "invalid-email",
      "duplicate-email",
    ]);
  });

  it("assigns one role per user, by priority, and flags several groups", () => {
    const plan = planMigration(
      [
        user({ id: "a", groups: ["Editors", "Admins"] }),
        user({ id: "b", groups: ["Editors"] }),
        user({ id: "c", groups: [] }),
        user({ id: "d", groups: ["Viewers", "Editors"] }),
      ],
      { ...OPTIONS, rolePriority: ["Admins", "Editors"] },
    );
    expect(plan.roleMembers.get("admins")).toEqual(["a"]);
    expect(plan.roleMembers.get("editors")).toEqual(["b", "d"]);
    expect(plan.withoutRole).toEqual(["c"]);
    expect(plan.issues.filter((i) => i.kind === "several-groups")).toHaveLength(
      2,
    );
  });

  it("reports a password hash that cannot be imported", () => {
    const plan = planMigration(
      [user({ id: "a", unsupportedHash: "argon2id" })],
      OPTIONS,
    );
    expect(plan.issues).toEqual([
      expect.objectContaining({ kind: "unsupported-hash", detail: "argon2id" }),
    ]);
  });
});

describe("applyPlan", () => {
  function fakeClient() {
    const calls = {
      imports: [] as number[],
      roles: [] as string[],
      grants: [] as { userIds: string[]; roleId?: string }[],
    };
    const client = {
      importUsers: vi.fn((rows: { email: string }[]) => {
        calls.imports.push(rows.length);
        return Promise.resolve({
          created: rows.length - 1,
          failed: 1,
          results: rows.map((r, i) =>
            i === 0
              ? {
                  email: r.email,
                  status: "error" as const,
                  message: "User already exists. Use another email or id.",
                }
              : { email: r.email, status: "created" as const },
          ),
        });
      }),
      listApplications: vi.fn(() =>
        Promise.resolve([{ id: "app-1", slug: "my-app" }]),
      ),
      listRoles: vi.fn(() =>
        Promise.resolve([{ id: "r-admin", name: "admins" }]),
      ),
      createRole: vi.fn((_app: string, name: string) => {
        calls.roles.push(name);
        return Promise.resolve(`r-${name}`);
      }),
      bulkGrant: vi.fn((_app: string, userIds: string[], roleId?: string) => {
        calls.grants.push({ userIds, roleId });
        return Promise.resolve();
      }),
    };
    return { client: client as unknown as MigrationClient, calls };
  }

  it("imports in batches, creates missing roles and grants access", async () => {
    const { client, calls } = fakeClient();
    const plan = planMigration(
      [
        user({ id: "a", groups: ["Admins"] }),
        user({ id: "b", groups: ["Editors"] }),
        user({ id: "c" }),
      ],
      { ...OPTIONS, appSlug: "my-app" },
    );
    const report = await applyPlan(client, plan, {
      ...OPTIONS,
      appSlug: "my-app",
      source: "okta",
    });

    expect(calls.imports).toEqual([3]);
    expect(report).toMatchObject({
      imported: 2,
      failed: 1,
      rolesCreated: ["editors"],
    });
    // "a" already existed (an earlier run): it still gets its role.
    expect(calls.grants).toEqual([
      { userIds: ["a"], roleId: "r-admin" },
      { userIds: ["b"], roleId: "r-editors" },
      { userIds: ["c"], roleId: undefined },
    ]);
    expect(report.granted).toBe(3);
  });

  it("only imports when no application is given", async () => {
    const { client, calls } = fakeClient();
    const plan = planMigration([user({ id: "a" }), user({ id: "b" })], OPTIONS);
    await applyPlan(client, plan, { ...OPTIONS, source: "auth0" });
    expect(calls.grants).toEqual([]);
  });

  it("refuses an application grant without the source ids", async () => {
    const { client } = fakeClient();
    await expect(
      applyPlan(client, planMigration([], OPTIONS), {
        ...OPTIONS,
        keepIds: false,
        appSlug: "my-app",
        source: "okta",
      }),
    ).rejects.toThrow(/--app needs the source ids/);
  });

  it("fails clearly for an unknown application", async () => {
    const { client } = fakeClient();
    await expect(
      applyPlan(client, planMigration([user({ id: "a" })], OPTIONS), {
        ...OPTIONS,
        appSlug: "ghost",
        source: "okta",
      }),
    ).rejects.toThrow(/No application with slug "ghost"/);
  });
});

describe("parseAuth0Export", () => {
  it("reads NDJSON and JSON array exports, with the bcrypt hash and roles", () => {
    const hash = `$2b$10$${"a".repeat(53)}`;
    const line = {
      user_id: "auth0|1",
      email: "a@example.com",
      email_verified: true,
      name: "Alice",
      passwordHash: hash,
      app_metadata: { roles: ["admin"] },
    };
    const noEmail = { user_id: "auth0|2" };
    for (const text of [
      `${JSON.stringify(line)}\n${JSON.stringify(noEmail)}\n`,
      JSON.stringify([line, noEmail]),
    ]) {
      expect(parseAuth0Export(text)).toEqual([
        {
          id: "auth0|1",
          email: "a@example.com",
          name: "Alice",
          emailVerified: true,
          groups: ["admin"],
          passwordHash: { algorithm: "bcrypt", hash },
        },
      ]);
    }
  });
});

describe("parseKeycloakRealm", () => {
  it("reads users, groups and PBKDF2 credentials, and skips service accounts", () => {
    const salt = randomBytes(16);
    const value = pbkdf2Sync("pw", salt, 27500, 64, "sha512").toString(
      "base64",
    );
    const credential = (algorithm: string) => ({
      type: "password",
      secretData: JSON.stringify({ value, salt: salt.toString("base64") }),
      credentialData: JSON.stringify({ hashIterations: 27500, algorithm }),
    });
    const realm = {
      users: [
        {
          id: "kc-1",
          username: "alice",
          email: "alice@example.com",
          emailVerified: true,
          firstName: "Alice",
          lastName: "Liddell",
          groups: ["/Engineering/Admins"],
          credentials: [credential("pbkdf2-sha512")],
        },
        {
          id: "kc-2",
          email: "bob@example.com",
          realmRoles: ["default-roles-demo", "offline_access", "editor"],
          credentials: [credential("argon2")],
        },
        { id: "kc-3", email: "svc@example.com", serviceAccountClientId: "svc" },
      ],
    };
    const users = parseKeycloakRealm(JSON.stringify(realm));
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({
      id: "kc-1",
      name: "Alice Liddell",
      groups: ["Admins"],
      passwordHash: {
        algorithm: "pbkdf2",
        digest: "sha512",
        iterations: 27500,
      },
    });
    expect(users[1]).toMatchObject({
      groups: ["editor"],
      unsupportedHash: "argon2",
    });
    expect(users[1]?.passwordHash).toBeUndefined();
  });
});

describe("fetchOktaUsers", () => {
  function response(body: unknown, link?: string) {
    return new Response(JSON.stringify(body), {
      headers: link ? { link } : {},
    });
  }

  it("pages through users and groups and ignores built-in groups", async () => {
    const fetchFn = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/v1/users?")) {
        return Promise.resolve(
          u.includes("after=1")
            ? response([
                {
                  id: "00u2",
                  profile: { email: "b@example.com", firstName: "Bob" },
                },
              ])
            : response(
                [
                  {
                    id: "00u1",
                    profile: {
                      email: "a@example.com",
                      firstName: "Al",
                      lastName: "Ice",
                    },
                  },
                ],
                '<https://acme.okta.com/api/v1/users?limit=200&after=1>; rel="next"',
              ),
        );
      }
      if (u.includes("/api/v1/groups?")) {
        return Promise.resolve(
          response([
            { id: "g1", type: "OKTA_GROUP", profile: { name: "Admins" } },
            { id: "g2", type: "BUILT_IN", profile: { name: "Everyone" } },
          ]),
        );
      }
      if (u.includes("/groups/g1/users")) {
        return Promise.resolve(response([{ id: "00u2" }]));
      }
      return Promise.resolve(new Response("nope", { status: 500 }));
    });

    const users = await fetchOktaUsers(
      "https://acme.okta.com/",
      "token",
      fetchFn as unknown as typeof fetch,
    );
    expect(users.map((u) => [u.id, u.name, u.groups])).toEqual([
      ["00u1", "Al Ice", []],
      ["00u2", "Bob", ["Admins"]],
    ]);
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes("g2"))).toBe(
      false,
    );
  });

  it("fails loudly when Okta refuses", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response("", { status: 401 })),
    );
    await expect(
      fetchOktaUsers(
        "https://acme.okta.com",
        "bad",
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Okta answered 401/);
  });
});
