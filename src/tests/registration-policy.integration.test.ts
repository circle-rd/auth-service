/**
 * Integration test — accounts are created through applications that allow
 * registration. A sign-up with no client_id, or naming an application that does
 * not allow it, is refused; a social sign-in only signs in existing accounts
 * unless registration is open.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { user, verification } from "../db/auth-schema.js";
import { applications } from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

const authorize = (slug: string): string =>
  `/api/auth/oauth2/authorize?client_id=${slug}&sig=x`;

describe("Registration policy (integration)", () => {
  let handle: AuthServerHandle;
  // The credential endpoints are rate-limited per address.
  let nextAddress = 1;
  const address = (): string => `10.9.0.${nextAddress++}`;

  const signUp = (email: string, callbackURL?: string) =>
    handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      remoteAddress: address(),
      payload: {
        email,
        password: "Password123!",
        name: "Someone",
        ...(callbackURL === undefined ? {} : { callbackURL }),
      },
      headers: { "content-type": "application/json" },
    });

  const exists = async (email: string): Promise<boolean> =>
    (await db.select({ id: user.id }).from(user).where(eq(user.email, email)))
      .length > 0;

  beforeAll(async () => {
    handle = await makeAuthServer();
  });

  beforeEach(async () => {
    await cleanDb();
    await db.insert(applications).values([
      { name: "Open", slug: "open-app", allowRegister: true },
      { name: "Closed", slug: "closed-app", allowRegister: false },
    ]);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it("refuses a sign-up without client_id", async () => {
    for (const callbackURL of [undefined, "/", "/profile?x=1", "not a url"]) {
      const res = await signUp("none@example.com", callbackURL);
      expect(res.statusCode).toBe(403);
    }
    expect(await exists("none@example.com")).toBe(false);
  });

  it("refuses a sign-up for an application that does not allow registration, or an unknown one", async () => {
    expect((await signUp("c@example.com", authorize("closed-app"))).statusCode).toBe(403);
    expect((await signUp("u@example.com", authorize("nope"))).statusCode).toBe(403);
    expect(await exists("c@example.com")).toBe(false);
    expect(await exists("u@example.com")).toBe(false);
  });

  it("accepts a sign-up for an application that allows registration", async () => {
    const res = await signUp("ok@example.com", authorize("open-app"));
    expect(res.statusCode).toBe(200);
    expect(await exists("ok@example.com")).toBe(true);
  });

  it("does not let a social sign-in create an account unless registration is open", async () => {
    const mutable = config as unknown as {
      providers: Record<string, { enabled: boolean }>;
    };
    expect(mutable.providers.github?.enabled).toBe(true);
    const social = async (callbackURL?: string) => {
      await db.delete(verification);
      const res = await handle.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/social",
        remoteAddress: address(),
        payload: {
          provider: "github",
          // A client must not be able to grant itself the right to register.
          requestSignUp: true,
          ...(callbackURL === undefined ? {} : { callbackURL }),
        },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      const [row] = await db
        .select({ value: verification.value })
        .from(verification);
      return (JSON.parse(row!.value) as { requestSignUp?: boolean })
        .requestSignUp;
    };
    expect(await social()).toBe(false);
    expect(await social(authorize("closed-app"))).toBe(false);
    expect(await social(authorize("nope"))).toBe(false);
    expect(await social(authorize("open-app"))).toBe(true);
  });
});
