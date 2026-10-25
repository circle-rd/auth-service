import bcrypt from "bcryptjs";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { config } from "../config.js";
import {
  MigrationClient,
  applyPlan,
  planMigration,
  type MigrationOptions,
} from "../scripts/migrate-lib.js";
import { parseAuth0Export } from "../scripts/migrate-sources.js";

let handle: AuthServerHandle;
let baseUrl: string;
let cookie: string;

beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
  baseUrl = await handle.app.listen({ port: 0, host: "127.0.0.1" });
  ({ cookie } = await signUpAndSignIn(handle, {
    email: "admin@example.com",
    password: "Password123!",
    name: "Admin",
  }));
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "admin@example.com"));
});

afterAll(async () => {
  await handle.cleanup();
});

const OPTIONS: MigrationOptions = {
  keepIds: true,
  trustEmail: true,
  sendVerification: false,
  appSlug: "migrated-app",
  rolePriority: [],
};

describe("migrate:auth0 against a running instance", () => {
  it("imports users with their ids and passwords, creates roles and grants access", async () => {
    const created = await handle.app.inject({
      method: "POST",
      url: "/api/admin/applications",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        name: "Migrated",
        slug: "migrated-app",
        url: "https://migrated.example.com",
        redirectUris: ["https://migrated.example.com/cb"],
      },
    });
    expect(created.statusCode).toBe(201);
    const appId = (JSON.parse(created.body) as { application: { id: string } })
      .application.id;

    const hash = bcrypt.hashSync("Auth0-Legacy-1", 10);
    const lines = [
      {
        user_id: "auth0|1",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        passwordHash: hash,
        app_metadata: { roles: ["Editors"] },
      },
      { user_id: "auth0|2", email: "bo@example.com", email_verified: true },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");

    const plan = planMigration(parseAuth0Export(lines), OPTIONS);
    const client = new MigrationClient(baseUrl, new URL(config.betterAuth.url).origin);
    await client.signIn("admin@example.com", "Password123!");
    const report = await applyPlan(client, plan, { ...OPTIONS, source: "auth0" });

    expect(report).toMatchObject({
      imported: 2,
      failed: 0,
      rolesCreated: ["editors"],
      granted: 2,
    });

    const [ada] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, "ada@example.com"));
    expect(ada?.id).toBe("auth0|1");

    const members = await client.listApplicationUsers(appId);
    expect(members.map((m) => m.userId).sort()).toEqual(
      expect.arrayContaining(["auth0|1", "auth0|2"]),
    );
    const roles = await client.listRoles(appId);
    const editors = roles.find((r) => r.name === "editors");
    expect(members.find((m) => m.userId === "auth0|1")?.roleId).toBe(
      editors?.id,
    );

    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email: "ada@example.com", password: "Auth0-Legacy-1" },
    });
    expect(signIn.statusCode).toBe(200);

    // A second run is harmless: everyone already exists.
    const again = await applyPlan(client, plan, { ...OPTIONS, source: "auth0" });
    expect(again).toMatchObject({ imported: 0, failed: 2, rolesCreated: [] });
  });
});
