import { createHash, createHmac, randomBytes } from "node:crypto";
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
import { cookiesFromResponse } from "./helpers/email-capture.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";

const APP_URL = "https://prompt-app.example.com";
const REDIRECT = `${APP_URL}/callback`;
const PASSWORD = "Password123!";
const JSON_HEADERS = { "content-type": "application/json" };

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "")) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// RFC 6238 defaults (SHA-1, 6 digits, 30 s), the ones the plugin uses.
function totpAt(secret: Buffer, stepOffset: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepOffset));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, "0");
}

let handle: AuthServerHandle;
let nextAddress = 1;
const address = (): string => `10.8.0.${nextAddress++}`;
const cookies = new Map<string, string>();

beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
  // The credential endpoints allow few calls per address: accounts are created
  // once for the whole file.
  const admin = await signUpAndSignIn(handle, {
    email: "admin@example.com",
    password: PASSWORD,
    name: "Admin",
  });
  await db
    .update(userTable)
    .set({ role: "superadmin" })
    .where(eq(userTable.email, "admin@example.com"));
  const created = await handle.app.inject({
    method: "POST",
    url: "/api/admin/applications",
    headers: { cookie: admin.cookie, ...JSON_HEADERS },
    payload: {
      name: "Prompt app",
      slug: "prompt-app",
      url: APP_URL,
      redirectUris: [REDIRECT],
      isPublic: true,
      skipConsent: true,
      allowedScopes: ["openid", "profile", "email"],
    },
  });
  expect(created.statusCode).toBe(201);
  for (const email of ["user@example.com", "mfa@example.com"]) {
    const { cookie } = await signUpAndSignIn(handle, {
      email,
      password: PASSWORD,
      name: email,
    });
    cookies.set(email, cookie);
  }
});

afterAll(async () => {
  await handle.cleanup();
});

function authorizeUrl(): string {
  const verifier = randomBytes(32).toString("base64url");
  return (
    "/api/auth/oauth2/authorize?" +
    new URLSearchParams({
      client_id: "prompt-app",
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "openid",
      prompt: "login",
      state: "xyz",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })
  );
}

// What the sign-in page receives: the signed query the authorize endpoint
// appends when it sends an unauthenticated browser to /login.
async function signedLoginQuery(): Promise<string> {
  const res = await handle.app.inject({ method: "GET", url: authorizeUrl() });
  expect(res.statusCode).toBe(302);
  const location = new URL(String(res.headers.location), "http://localhost");
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("prompt")).toBe("login");
  return location.search.slice(1);
}

describe("sign-in page flow with prompt=login", () => {
  it("sends the browser back to the sign-in page when oauth_query is omitted", async () => {
    const query = await signedLoginQuery();
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: address(),
      headers: JSON_HEADERS,
      payload: {
        email: "user@example.com",
        password: PASSWORD,
        callbackURL: `/api/auth/oauth2/authorize?${query}`,
      },
    });
    expect(signIn.statusCode).toBe(200);
    const { url } = JSON.parse(signIn.body) as { url: string };
    const resumed = new URL(url, "http://localhost");
    const followed = await handle.app.inject({
      method: "GET",
      url: resumed.pathname + resumed.search,
      headers: { cookie: cookiesFromResponse(signIn.headers["set-cookie"]) },
    });
    expect(
      new URL(String(followed.headers.location), "http://localhost").pathname,
    ).toBe("/login");
  });

  it("lands on the application after a password sign-in that carries oauth_query", async () => {
    const query = await signedLoginQuery();
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: address(),
      headers: JSON_HEADERS,
      payload: {
        email: "user@example.com",
        password: PASSWORD,
        callbackURL: `/api/auth/oauth2/authorize?${query}`,
        oauth_query: query,
      },
    });
    expect(signIn.statusCode).toBe(200);
    const { url } = JSON.parse(signIn.body) as { url: string };
    expect(url).toMatch(new RegExp(`^${REDIRECT}\\?code=`));
  });

  it("lands on the application after a second factor that carries oauth_query", async () => {
    const cookie = cookies.get("mfa@example.com");
    const enable = await handle.app.inject({
      method: "POST",
      url: "/api/auth/two-factor/enable",
      headers: { cookie, ...JSON_HEADERS },
      payload: { password: PASSWORD },
    });
    expect(enable.statusCode).toBe(200);
    const { totpURI } = JSON.parse(enable.body) as { totpURI: string };
    const secret = base32Decode(
      new URL(totpURI).searchParams.get("secret") ?? "",
    );
    const confirm = await handle.app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      remoteAddress: address(),
      headers: { cookie, ...JSON_HEADERS },
      payload: { code: totpAt(secret, 0) },
    });
    expect(confirm.statusCode).toBe(200);


    const query = await signedLoginQuery();
    const signIn = await handle.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: address(),
      headers: JSON_HEADERS,
      payload: {
        email: "mfa@example.com",
        password: PASSWORD,
        callbackURL: `/api/auth/oauth2/authorize?${query}`,
        oauth_query: query,
      },
    });
    expect(signIn.statusCode).toBe(200);
    expect(JSON.parse(signIn.body)).toMatchObject({ twoFactorRedirect: true });

    const verify = await handle.app.inject({
      method: "POST",
      url: "/api/auth/two-factor/verify-totp",
      remoteAddress: address(),
      headers: {
        cookie: cookiesFromResponse(signIn.headers["set-cookie"]),
        ...JSON_HEADERS,
      },
      // The step the setup confirmation consumed cannot be replayed.
      payload: { code: totpAt(secret, 1), oauth_query: query },
    });
    expect(verify.statusCode).toBe(200);
    const { url } = JSON.parse(verify.body) as { url: string };
    expect(url).toMatch(new RegExp(`^${REDIRECT}\\?code=`));
  });
});
