import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl, toPath } from "./helpers/email-capture.js";
import { db } from "../db/index.js";
import {
  member as memberTable,
  organization as organizationTable,
  user as userTable,
} from "../db/auth-schema.js";

const dnsState = vi.hoisted(() => ({ records: [] as string[][] }));

vi.mock("node:dns/promises", () => ({
  resolveTxt: vi.fn(async () => dnsState.records),
}));

let handle: AuthServerHandle;
let cookie: string;

beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
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

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

describe("organization domain auto-enrollment", () => {
  it("verifies a domain and enrolls a newly verified user", async () => {
    const created = await handle.app.inject({
      method: "POST",
      url: "/api/admin/organizations",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        name: "Acme",
        slug: "acme",
        domain: "example.com",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = json<{
      organization: { id: string };
      domainVerification: { recordName: string; recordValue: string };
    }>(created.body);
    const organizationId = createdBody.organization.id;

    expect(createdBody.domainVerification.recordName).toBe(
      "_circle-auth.example.com",
    );
    dnsState.records = [[createdBody.domainVerification.recordValue]];

    const verified = await handle.app.inject({
      method: "POST",
      url: `/api/admin/organizations/${organizationId}/domain/verify`,
      headers: { cookie },
    });
    expect(verified.statusCode).toBe(200);

    const enabled = await handle.app.inject({
      method: "PATCH",
      url: `/api/admin/organizations/${organizationId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { autoEnrollEnabled: true },
    });
    expect(enabled.statusCode).toBe(200);

    const { cookie: memberCookie } = await signUpAndSignIn(handle, {
      email: "alice@example.com",
      password: "Password123!",
      name: "Alice",
    });
    expect(memberCookie).toBeTruthy();

    const [alice] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, "alice@example.com"));
    const [membership] = await db
      .select({ role: memberTable.role })
      .from(memberTable)
      .where(
        and(
          eq(memberTable.organizationId, organizationId),
          eq(memberTable.userId, alice.id),
        ),
      );
    expect(membership?.role).toBe("member");
  });

  it("refuses auto-enrollment until the domain is verified", async () => {
    const created = await handle.app.inject({
      method: "POST",
      url: "/api/admin/organizations",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        name: "Unverified",
        slug: "unverified",
        domain: "unverified.example",
      },
    });
    const organizationId = json<{ organization: { id: string } }>(
      created.body,
    ).organization.id;
    const enabled = await handle.app.inject({
      method: "PATCH",
      url: `/api/admin/organizations/${organizationId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: { autoEnrollEnabled: true },
    });
    expect(enabled.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(enabled.body).error.code).toBe(
      "ORG_009",
    );
  });

  it("does not auto-enroll an existing account that later changes its email", async () => {
    const [org] = await db
      .select()
      .from(organizationTable)
      .where(eq(organizationTable.slug, "acme"));

    const { cookie: oldCookie } = await signUpAndSignIn(handle, {
      email: "charlie@elsewhere.test",
      password: "Password123!",
      name: "Charlie",
    });

    const change = await handle.app.inject({
      method: "POST",
      url: "/api/auth/change-email",
      headers: { "content-type": "application/json", cookie: oldCookie },
      payload: { newEmail: "charlie@example.com", callbackURL: "/" },
    });
    expect(change.statusCode).toBe(200);

    const confirm = handle.capture.last("charlie@elsewhere.test");
    expect(confirm).toBeDefined();
    const confirmUrl = extractUrl(confirm!.html, (url) =>
      url.includes("/api/auth/verify-email"),
    );
    await handle.app.inject({ method: "GET", url: toPath(confirmUrl) });

    const verification = handle.capture.last("charlie@example.com");
    expect(verification).toBeDefined();
    const verificationUrl = extractUrl(verification!.html, (url) =>
      url.includes("/api/auth/verify-email"),
    );
    await handle.app.inject({ method: "GET", url: toPath(verificationUrl) });

    const [charlie] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, "charlie@example.com"));
    const [membership] = await db
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(
        and(
          eq(memberTable.organizationId, org.id),
          eq(memberTable.userId, charlie.id),
        ),
      );
    expect(membership).toBeUndefined();
  });

  it("disables auto-enrollment when the DNS proof disappears", async () => {
    const [org] = await db
      .select()
      .from(organizationTable)
      .where(eq(organizationTable.slug, "acme"));
    await db
      .update(organizationTable)
      .set({
        domainLastCheckedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      })
      .where(eq(organizationTable.id, org.id));
    dnsState.records = [];

    await signUpAndSignIn(handle, {
      email: "bob@example.com",
      password: "Password123!",
      name: "Bob",
    });

    const [after] = await db
      .select({
        autoEnrollEnabled: organizationTable.autoEnrollEnabled,
      })
      .from(organizationTable)
      .where(eq(organizationTable.id, org.id));
    expect(after.autoEnrollEnabled).toBe(false);

    const [bob] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, "bob@example.com"));
    const [membership] = await db
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(
        and(
          eq(memberTable.organizationId, org.id),
          eq(memberTable.userId, bob.id),
        ),
      );
    expect(membership).toBeUndefined();
  });
});
