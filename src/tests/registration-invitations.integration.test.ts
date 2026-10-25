/**
 * Integration test — administrator-triggered one-shot registration invites.
 *
 * Covers creation + email, the templated redemption page, successful
 * redemption (account created, verified, app access granted), single use, the
 * expiry/revocation paths and the authorization boundary.
 *
 * A single admin session is created once and reused: the auth endpoints carry a
 * strict per-IP rate limit, so signing up an admin per case would trip it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  applications,
  registrationInvitations,
  userApplications,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { extractUrl } from "./helpers/email-capture.js";

describe("Registration invitations (integration)", () => {
  let handle: AuthServerHandle;
  let dir: string;
  let adminCookieValue: string;
  const ADMIN_EMAIL = "admin@example.com";
  const mutable = config as unknown as { templatesDir: string | null };
  const originalDir = mutable.templatesDir;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "invite-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    writeFileSync(
      join(dir, "default", "complete-registration.html"),
      "<%= it.EMAIL %>|<%= it.INVITATION_TOKEN %>",
    );
    mutable.templatesDir = dir;
    handle = await makeAuthServer();
    await cleanDb();

    const { cookie } = await signUpAndSignIn(handle, {
      email: ADMIN_EMAIL,
      password: "Password123!",
      name: "Admin",
    });
    const session = await handle.app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie },
    });
    const userId = session.json<{ user: { id: string } }>().user.id;
    await db
      .update(userTable)
      .set({ role: "admin" })
      .where(eq(userTable.id, userId));
    adminCookieValue = cookie;
    handle.capture.clear();
  });

  afterAll(async () => {
    mutable.templatesDir = originalDir;
    await handle.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  /** A fresh, uniquely-slugged closed application for one case. */
  const makeClosedApp = async (): Promise<string> => {
    const [app] = await db
      .insert(applications)
      .values({
        name: `Closed app ${seq}`,
        slug: `closed-app-${seq++}`,
        allowRegister: false,
      })
      .returning({ id: applications.id });
    return app.id;
  };

  const adminCookie = () => adminCookieValue;

  let emailSeq = 0;
  const freshEmail = () => `guest-${emailSeq++}@example.com`;

  const createInvitation = async (appId: string, email: string) =>
    handle.app.inject({
      method: "POST",
      url: "/api/admin/registration-invitations",
      headers: { "content-type": "application/json", cookie: adminCookie() },
      payload: { email, applicationId: appId },
    });

  const tokenFromLastEmail = (email: string): string => {
    const msg = handle.capture.last(email);
    if (!msg) throw new Error("no invitation email captured");
    const url = extractUrl(msg.html, (u) => u.includes("/complete-registration"));
    return new URL(url).searchParams.get("token") ?? "";
  };

  it("creates an invitation and emails a one-shot link", async () => {
    const appId = await makeClosedApp();
    const email = freshEmail();
    const res = await createInvitation(appId, email);
    expect(res.statusCode).toBe(201);
    const body = res.json<{ invitation: { email: string }; emailSent: boolean }>();
    expect(body.invitation.email).toBe(email);
    expect(body.emailSent).toBe(true);

    const token = tokenFromLastEmail(email);
    expect(token.length).toBeGreaterThan(20);
  });

  it("rejects an invitation for an address that already has an account", async () => {
    const appId = await makeClosedApp();
    const res = await createInvitation(appId, ADMIN_EMAIL);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("AUTH_013");
  });

  it("requires an admin", async () => {
    const appId = await makeClosedApp();
    const res = await handle.app.inject({
      method: "POST",
      url: "/api/admin/registration-invitations",
      headers: { "content-type": "application/json" },
      payload: { email: freshEmail(), applicationId: appId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("renders the redemption page for a pending token", async () => {
    const appId = await makeClosedApp();
    const email = freshEmail();
    await createInvitation(appId, email);
    const token = tokenFromLastEmail(email);

    const res = await handle.app.inject({
      method: "GET",
      url: `/complete-registration?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(email);
    expect(res.body).toContain(token);
  });

  it("redirects an unknown token to the error page", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/complete-registration?token=not-a-real-token",
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain("error=INVITATION_INVALID");
  });

  it("redeems an invitation once and grants application access", async () => {
    const appId = await makeClosedApp();
    const email = freshEmail();
    await createInvitation(appId, email);
    const token = tokenFromLastEmail(email);

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/registration/complete",
      headers: { "content-type": "application/json" },
      payload: { token, name: "Guest User", password: "Password123!" },
    });
    expect(res.statusCode).toBe(200);

    const [user] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    expect(user?.emailVerified).toBe(true);

    const [access] = await db
      .select({ userId: userApplications.userId })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, user!.id),
          eq(userApplications.applicationId, appId),
        ),
      )
      .limit(1);
    expect(access?.userId).toBe(user?.id);

    const [invitation] = await db
      .select({ consumedAt: registrationInvitations.consumedAt })
      .from(registrationInvitations)
      .where(eq(registrationInvitations.applicationId, appId))
      .limit(1);
    expect(invitation?.consumedAt).not.toBeNull();
  });

  it("refuses to redeem the same invitation twice", async () => {
    const appId = await makeClosedApp();
    const email = freshEmail();
    await createInvitation(appId, email);
    const token = tokenFromLastEmail(email);

    const payload = { token, name: "Guest User", password: "Password123!" };
    const first = await handle.app.inject({
      method: "POST",
      url: "/api/registration/complete",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await handle.app.inject({
      method: "POST",
      url: "/api/registration/complete",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("AUTH_012");
  });

  it("refuses an expired invitation", async () => {
    const appId = await makeClosedApp();
    const email = freshEmail();
    await createInvitation(appId, email);
    const token = tokenFromLastEmail(email);
    await db
      .update(registrationInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(registrationInvitations.applicationId, appId));

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/registration/complete",
      headers: { "content-type": "application/json" },
      payload: { token, name: "Guest User", password: "Password123!" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a revoked invitation", async () => {
    const appId = await makeClosedApp();
    const email = freshEmail();
    const created = await createInvitation(appId, email);
    const invitationId = created.json<{ invitation: { id: string } }>().invitation.id;
    const token = tokenFromLastEmail(email);

    const revoked = await handle.app.inject({
      method: "DELETE",
      url: `/api/admin/registration-invitations/${invitationId}`,
      headers: { cookie: adminCookie() },
    });
    expect(revoked.statusCode).toBe(200);

    const res = await handle.app.inject({
      method: "POST",
      url: "/api/registration/complete",
      headers: { "content-type": "application/json" },
      payload: { token, name: "Guest User", password: "Password123!" },
    });
    expect(res.statusCode).toBe(400);
  });
});
