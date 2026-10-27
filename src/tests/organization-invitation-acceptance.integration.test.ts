/**
 * Integration test — organization invitation redemption.
 *
 * Covers the public `/accept-invitation` page, password registration inside a
 * closed instance, acceptance by an existing account, email mismatch rejection
 * and the entry point used by social sign-in.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeAuthServer, signUpAndSignIn, type AuthServerHandle } from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import {
  invitation,
  member,
  user as userTable,
} from "../db/auth-schema.js";
import { userApplications } from "../db/schema.js";
import { assertInvitationFlowEmail } from "../services/invitation-flows.js";

interface InvitationSetup {
  invitationId: string;
  inviteeEmail: string;
  organizationId: string;
  organizationName: string;
}

describe("Organization invitation redemption (integration)", () => {
  let handle: AuthServerHandle;
  let adminCookie: string;
  let memberCookie: string;
  const adminEmail = "org-admin@example.com";
  const memberEmail = "org-member@example.com";
  const password = "good-password-12345";
  let sequence = 0;

  beforeAll(async () => {
    handle = await makeAuthServer();
    const admin = await signUpAndSignIn(handle, {
      email: adminEmail,
      password,
      name: "Org Admin",
    });
    adminCookie = admin.cookie;
    await db
      .update(userTable)
      .set({ role: "admin" })
      .where(eq(userTable.email, adminEmail));

    const member = await signUpAndSignIn(handle, {
      email: memberEmail,
      password,
      name: "Org Member",
    });
    memberCookie = member.cookie;
    handle.capture.clear();
  });

  afterAll(async () => {
    await handle.cleanup();
    await cleanDb();
  });

  async function createInvitation(
    inviteeEmail: string,
    name = "Acme",
  ): Promise<InvitationSetup> {
    sequence += 1;
    const slug = `${name.toLowerCase()}-${sequence}`;
    const createOrg = await handle.app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      payload: { name: `${name} ${sequence}`, slug },
      headers: { "content-type": "application/json", cookie: adminCookie },
    });
    expect(createOrg.statusCode).toBe(200);
    const { id: organizationId } = createOrg.json<{ id: string }>();

    const invite = await handle.app.inject({
      method: "POST",
      url: "/api/auth/organization/invite-member",
      payload: { email: inviteeEmail, role: "member", organizationId },
      headers: { "content-type": "application/json", cookie: adminCookie },
    });
    expect(invite.statusCode).toBe(200);
    const { id } = invite.json<{ id: string }>();

    return {
      invitationId: id,
      inviteeEmail,
      organizationId,
      organizationName: `${name} ${sequence}`,
    };
  }

  it("renders the invitation page and redirects unknown ids to the error page", async () => {
    const setup = await createInvitation("invite-page@example.com");

    const page = await handle.app.inject({
      method: "GET",
      url: `/accept-invitation?id=${encodeURIComponent(setup.invitationId)}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain(setup.organizationName);
    expect(page.body).toContain(setup.inviteeEmail);
    expect(page.body).toContain("Create account and join");

    const invalid = await handle.app.inject({
      method: "GET",
      url: "/accept-invitation?id=does-not-exist",
    });
    expect(invalid.statusCode).toBe(302);
    expect(invalid.headers.location).toContain("error=INVITATION_INVALID");
  });

  it("creates a verified account, joins the organization and consumes the invitation once", async () => {
    const setup = await createInvitation("invite-password@example.com");

    const complete = await handle.app.inject({
      method: "POST",
      url: "/api/registration/organization-invitation/complete",
      payload: {
        invitationId: setup.invitationId,
        name: "Invited Person",
        password,
      },
      headers: { "content-type": "application/json" },
    });
    expect(complete.statusCode).toBe(200);
    const body = complete.json<{ email: string; organizationId: string }>();
    expect(body.email).toBe(setup.inviteeEmail);
    expect(body.organizationId).toBe(setup.organizationId);

    const [createdUser] = await db
      .select({ id: userTable.id, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, setup.inviteeEmail));
    expect(createdUser).toBeDefined();
    expect(createdUser!.emailVerified).toBe(true);

    const [createdMember] = await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, createdUser!.id),
          eq(member.organizationId, setup.organizationId),
        ),
      );
    expect(createdMember?.role).toBe("member");

    const [storedInvitation] = await db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, setup.invitationId));
    expect(storedInvitation?.status).toBe("accepted");

    const appAccess = await db
      .select({ userId: userApplications.userId })
      .from(userApplications)
      .where(eq(userApplications.userId, createdUser!.id));
    expect(appAccess).toHaveLength(0);

    const replay = await handle.app.inject({
      method: "POST",
      url: "/api/registration/organization-invitation/complete",
      payload: {
        invitationId: setup.invitationId,
        name: "Invited Person",
        password,
      },
      headers: { "content-type": "application/json" },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe(
      "AUTH_012",
    );
  });

  it("rejects a signed-in account with another address, then accepts for the invited account", async () => {
    const setup = await createInvitation(memberEmail);

    const mismatch = await handle.app.inject({
      method: "POST",
      url: "/api/registration/organization-invitation/accept",
      payload: { invitationId: setup.invitationId },
      headers: { "content-type": "application/json", cookie: adminCookie },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json<{ error: { code: string } }>().error.code).toBe(
      "AUTH_014",
    );

    const page = await handle.app.inject({
      method: "GET",
      url: `/accept-invitation?id=${encodeURIComponent(setup.invitationId)}`,
      headers: { cookie: memberCookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Signed in as");
    expect(page.body).toContain(memberEmail);

    const accepted = await handle.app.inject({
      method: "POST",
      url: "/api/registration/organization-invitation/accept",
      payload: { invitationId: setup.invitationId },
      headers: { "content-type": "application/json", cookie: memberCookie },
    });
    expect(accepted.statusCode).toBe(200);

    const [memberRow] = await db
      .select({ id: member.id })
      .from(member)
      .innerJoin(userTable, eq(userTable.id, member.userId))
      .where(
        and(
          eq(userTable.email, memberEmail),
          eq(member.organizationId, setup.organizationId),
        ),
      );
    expect(memberRow).toBeDefined();

    const [storedInvitation] = await db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, setup.invitationId));
    expect(storedInvitation?.status).toBe("accepted");
  });

  it("starts a social sign-in and carries the invited address in server-trusted state", async () => {
    const setup = await createInvitation("invite-social@example.com");
    const flow = {
      kind: "organization" as const,
      invitationId: setup.invitationId,
      email: setup.inviteeEmail,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    await expect(
      assertInvitationFlowEmail(flow, "someone-else@example.com"),
    ).rejects.toMatchObject({
      body: { code: "INVITATION_EMAIL_MISMATCH" },
    });
    await expect(
      assertInvitationFlowEmail(flow, setup.inviteeEmail),
    ).resolves.toBeUndefined();

    const start = await handle.app.inject({
      method: "POST",
      url: "/api/registration/organization-invitation/social",
      payload: { invitationId: setup.invitationId, provider: "github" },
      headers: { "content-type": "application/json" },
    });
    expect(start.statusCode).toBe(200);
    const body = start.json<{ url: string }>();
    expect(body.url).toContain("github.com");

    const rawCookies = start.headers["set-cookie"];
    const joined = Array.isArray(rawCookies)
      ? rawCookies.join("\n")
      : String(rawCookies ?? "");
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain("auth_invitation_flow=");
  });
});
