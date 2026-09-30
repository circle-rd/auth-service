/**
 * Integration test — organization invitation email.
 *
 * 1. Sign up + verify an admin user (auto-elevated to "admin" so they can
 *    create an org and invite members).
 * 2. Create an organization.
 * 3. POST /api/auth/organization/invite-member — invitation email captured.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";

describe("Email — organization invitation flow (integration)", () => {
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

  it("emails an invitation link that carries the inviter, organization, and accept URL", async () => {
    const inviterEmail = "owner@example.com";
    const inviteeEmail = "invitee@example.com";
    const password = "good-password-12345";

    const { cookie } = await signUpAndSignIn(handle, {
      email: inviterEmail,
      password,
      name: "Owner",
    });

    // Elevate to "admin" so `allowUserToCreateOrganization` passes.
    await db
      .update(userTable)
      .set({ role: "admin" })
      .where(eq(userTable.email, inviterEmail));

    const createOrg = await handle.app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      payload: { name: "Acme", slug: "acme" },
      headers: { "content-type": "application/json", cookie },
    });
    expect(createOrg.statusCode).toBe(200);
    const { id: organizationId } = createOrg.json<{ id: string }>();

    const invite = await handle.app.inject({
      method: "POST",
      url: "/api/auth/organization/invite-member",
      payload: { email: inviteeEmail, role: "member", organizationId },
      headers: { "content-type": "application/json", cookie },
    });
    expect(invite.statusCode).toBe(200);

    const msg = handle.capture.last(inviteeEmail);
    expect(msg).toBeDefined();
    expect(msg!.subject).toMatch(/invit/i);
    expect(msg!.html).toContain("Acme");
    expect(msg!.html).toContain("Owner");
    expect(msg!.html).toContain("/accept-invitation");
  });
});
