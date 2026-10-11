import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { applications } from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

let handle: AuthServerHandle;
let superadminCookie: string;
let adminCookie: string;

async function signInAs(
  email: string,
  role: "admin" | "superadmin",
): Promise<string> {
  const { cookie } = await signUpAndSignIn(handle, {
    email,
    password: "Password123!",
    name: email,
  });
  await db.update(userTable).set({ role }).where(eq(userTable.email, email));
  return cookie;
}

async function api(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  body?: unknown,
) {
  const res = await handle.app.inject({
    method,
    url,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.statusCode,
    body: JSON.parse(res.body || "{}") as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

async function createApp(cookie: string, slug: string, isSystem?: boolean) {
  return api("POST", "/api/admin/applications", cookie, {
    name: slug,
    slug,
    ...(isSystem === undefined ? {} : { isSystem }),
  });
}

beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
  superadminCookie = await signInAs("root@example.com", "superadmin");
  adminCookie = await signInAs("admin@example.com", "admin");
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE applications, oauth_client CASCADE`);
});

describe("system applications", () => {
  it("are ordinary applications unless a superadmin says otherwise", async () => {
    const created = await createApp(adminCookie, "plain-app");
    expect(created.status).toBe(201);
    expect(created.body.application.isSystem).toBe(false);
  });

  it("can be created by a superadmin and stay in the list, flagged", async () => {
    const created = await createApp(superadminCookie, "infra-app", true);
    expect(created.status).toBe(201);
    expect(created.body.application.isSystem).toBe(true);

    const list = await api("GET", "/api/admin/applications", adminCookie);
    const entry = list.body.applications.find(
      (a: { slug: string }) => a.slug === "infra-app",
    );
    expect(entry.isSystem).toBe(true);
  });

  it("cannot be created or flagged by a plain admin", async () => {
    expect((await createApp(adminCookie, "sneaky", true)).status).toBe(403);
    expect(await db.select().from(applications)).toHaveLength(0);

    const created = await createApp(superadminCookie, "ordinary");
    const id = created.body.application.id;
    const patch = await api("PATCH", `/api/admin/applications/${id}`, adminCookie, {
      isSystem: true,
    });
    expect(patch.status).toBe(403);
  });

  it("refuse deletion with APP_007 and survive it", async () => {
    const created = await createApp(superadminCookie, "infra-app", true);
    const id = created.body.application.id;
    const res = await api("DELETE", `/api/admin/applications/${id}`, superadminCookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("APP_007");
    expect(await db.select().from(applications)).toHaveLength(1);
  });

  it("keep the flag through an update that does not mention it", async () => {
    const created = await createApp(superadminCookie, "infra-app", true);
    const id = created.body.application.id;
    const patch = await api("PATCH", `/api/admin/applications/${id}`, adminCookie, {
      description: "changed",
    });
    expect(patch.status).toBe(200);
    expect(patch.body.application?.isSystem ?? patch.body.isSystem).toBe(true);
  });

  it("become deletable once a superadmin clears the flag", async () => {
    const created = await createApp(superadminCookie, "infra-app", true);
    const id = created.body.application.id;
    const cleared = await api(
      "PATCH",
      `/api/admin/applications/${id}`,
      superadminCookie,
      { isSystem: false },
    );
    expect(cleared.status).toBe(200);
    const res = await api("DELETE", `/api/admin/applications/${id}`, superadminCookie);
    expect(res.status).toBe(204);
  });
});
