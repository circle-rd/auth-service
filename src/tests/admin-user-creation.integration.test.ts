/**
 * Issue #58 — an admin must be able to create a lower-ranked user.
 *
 * The native `/admin/create-user` endpoint requires `user:set-role` the moment
 * a `role` field is present in the body, and the `admin` role deliberately does
 * not hold that permission (src/auth.ts). A route that always forwards `role`,
 * including its `"user"` default, therefore denies every admin-provisioned
 * account. These cases drive the real BetterAuth handler over the real server.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
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

let handle: AuthServerHandle;

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  handle.capture.clear();
});

function jsonHeaders(cookie: string): Record<string, string> {
  return { "content-type": "application/json", cookie };
}

async function promoteTo(cookie: string, role: string): Promise<void> {
  const session = await handle.app.inject({
    method: "GET",
    url: "/api/auth/get-session",
    headers: jsonHeaders(cookie),
  });
  const userId = session.json<{ user: { id: string } }>().user.id;
  await db
    .update(userTable)
    .set({ role })
    .where(eq(userTable.id, userId));
}

async function roleOf(email: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  return row?.role;
}

describe("admin user creation — issue #58", () => {
  it("lets an admin create a lower-ranked user, whichever role form is posted", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "Password123!",
      name: "Admin",
    });
    await promoteTo(cookie, "admin");

    // The SPA always posts the `role` field, defaulting to "user".
    const withRole = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: jsonHeaders(cookie),
      payload: {
        name: "New User",
        email: "created-with-role@example.com",
        password: "Password123!",
        role: "user",
      },
    });
    expect(withRole.statusCode).toBe(201);

    // A caller that omits the field must work just the same.
    const withoutRole = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: jsonHeaders(cookie),
      payload: {
        name: "New User",
        email: "created-without-role@example.com",
        password: "Password123!",
      },
    });
    expect(withoutRole.statusCode).toBe(201);

    expect(await roleOf("created-with-role@example.com")).toBe("user");
    expect(await roleOf("created-without-role@example.com")).toBe("user");

    // Non-regression: an admin may not create an admin.
    const denied = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: jsonHeaders(cookie),
      payload: {
        name: "Escalated",
        email: "escalated@example.com",
        password: "Password123!",
        role: "admin",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe(
      "AUTH_011",
    );
    expect(await roleOf("escalated@example.com")).toBeUndefined();
  });

  it("lets a superadmin create an admin user", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "superadmin@example.com",
      password: "Password123!",
      name: "Superadmin",
    });
    await promoteTo(cookie, "superadmin");

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: jsonHeaders(cookie),
      payload: {
        name: "Peer Admin",
        email: "peer-admin@example.com",
        password: "Password123!",
        role: "admin",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(await roleOf("peer-admin@example.com")).toBe("admin");
  });

  it("lets an admin import user rows while admin rows stay refused", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "Password123!",
      name: "Admin",
    });
    await promoteTo(cookie, "admin");

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/admin/users/import",
      headers: jsonHeaders(cookie),
      payload: {
        users: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com", role: "user" },
          { name: "Root", email: "root@example.com", role: "admin" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      created: number;
      failed: number;
      results: Array<{ email: string; status: string; message?: string }>;
    }>();
    expect(body.created).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results.find((r) => r.email === "root@example.com")?.message).toBe(
      "Only superadmins can create admin users",
    );
    expect(await roleOf("alice@example.com")).toBe("user");
    expect(await roleOf("bob@example.com")).toBe("user");
    expect(await roleOf("root@example.com")).toBeUndefined();
  });
});
