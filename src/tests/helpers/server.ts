/**
 * Integration test factory: full Fastify server + in-memory mail capture.
 *
 * Returns a freshly-built FastifyInstance backed by the global testcontainer
 * Postgres (started by `tests/global-setup.ts`) with the outbound mail
 * transport swapped for a `MailCaptureTransport`. Tests drive HTTP via
 * `app.inject()` and assert on `capture.messages`.
 */
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server.js";
import {
  setMailTransport,
} from "../../services/mail/index.js";
import { MailCaptureTransport } from "../../services/mail/capture-transport.js";
import { extractUrl, toPath, cookiesFromResponse } from "./email-capture.js";

export interface AuthServerHandle {
  app: FastifyInstance;
  capture: MailCaptureTransport;
  cleanup: () => Promise<void>;
}

export async function makeAuthServer(): Promise<AuthServerHandle> {
  const capture = new MailCaptureTransport();
  setMailTransport(capture);

  const app = await buildServer();
  await app.ready();

  return {
    app,
    capture,
    cleanup: async () => {
      await app.close();
      setMailTransport(null);
    },
  };
}

/**
 * Sign up a brand-new user, follow the verification link from the captured
 * email, sign in with the credentials, and return the session cookie header
 * value ready to be set on subsequent inject() calls.
 *
 * Resets the capture buffer at the end so the caller starts from a clean
 * state when asserting on the flow under test.
 */
export async function signUpAndSignIn(
  handle: AuthServerHandle,
  opts: { email: string; password: string; name: string },
): Promise<{ cookie: string }> {
  const { app, capture } = handle;

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: opts,
    headers: { "content-type": "application/json" },
  });
  if (signUp.statusCode !== 200) {
    throw new Error(`sign-up failed: ${signUp.statusCode} ${signUp.body}`);
  }
  const verifyMsg = capture.last(opts.email);
  if (!verifyMsg) throw new Error("no verification email captured");
  const verifyUrl = extractUrl(verifyMsg.html, (u) => u.includes("/api/auth/verify-email"));
  await app.inject({ method: "GET", url: toPath(verifyUrl) });

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: opts.email, password: opts.password },
    headers: { "content-type": "application/json" },
  });
  if (signIn.statusCode !== 200) {
    throw new Error(`sign-in failed: ${signIn.statusCode} ${signIn.body}`);
  }
  const cookie = cookiesFromResponse(signIn.headers["set-cookie"]);
  capture.clear();
  return { cookie };
}
