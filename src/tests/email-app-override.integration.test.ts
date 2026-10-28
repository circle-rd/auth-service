/**
 * Integration test — per-application email overrides.
 *
 * The application an email belongs to is read from the `client_id` of the
 * link's `callbackURL`, so a sign-in started from an application's own login
 * page is mailed with that application's templates.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { config } from "../config.js";
import { cleanDb } from "./helpers/db.js";

const EMAIL = "tenant-user@example.com";

describe("Email — per-application overrides (integration)", () => {
  let handle: AuthServerHandle;
  const mutable = config as unknown as { templatesDir: string | null };
  const originalDir = mutable.templatesDir;
  const dir = mkdtempSync(join(tmpdir(), "email-override-"));

  beforeAll(async () => {
    const emails = join(dir, "tenant-app", "emails");
    mkdirSync(emails, { recursive: true });
    writeFileSync(
      join(emails, "magic-link.eml"),
      "---\nsubject: Tenant sign-in\n---\n<p><a href=\"<%~ it.url %>\">go</a></p>\n",
    );
    mutable.templatesDir = dir;
    handle = await makeAuthServer();
  });

  afterAll(async () => {
    mutable.templatesDir = originalDir;
    await handle.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanDb();
    handle.capture.clear();
    await signUpAndSignIn(handle, {
      email: EMAIL,
      password: "Password123!",
      name: "Tenant User",
    });
    handle.capture.clear();
  });

  async function requestMagicLink(callbackURL: string): Promise<string> {
    const res = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      payload: { email: EMAIL, callbackURL },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const msg = handle.capture.last(EMAIL);
    expect(msg).toBeDefined();
    return msg!.subject;
  }

  it("uses the template of the application named by the callback", async () => {
    const subject = await requestMagicLink(
      "/api/auth/oauth2/authorize?client_id=tenant-app",
    );

    expect(subject).toBe("Tenant sign-in");
  });

  it.each([
    ["no application", "/"],
    ["an application without templates", "/x?client_id=other-app"],
    ["an unsafe client id", "/x?client_id=../../escape"],
  ])("falls back to the default template for %s", async (_label, callbackURL) => {
    const subject = await requestMagicLink(callbackURL);

    expect(subject).not.toBe("Tenant sign-in");
    expect(subject).toMatch(/sign.?in|magic/i);
  });
});
