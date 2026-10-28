import { z } from "zod";
import { ERR } from "../errors.js";
import { assertNonLocalHost } from "./outbound-guard.js";

// The provider plugin applies these syntactic rules to the clients it registers
// itself; the admin routes write the client directly, so they are repeated here.
// A logout token is a credential: it must travel over TLS, to a URL that carries
// no credentials of its own.
export const backchannelLogoutUriSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "must be an https URL" });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "must not embed credentials" });
    }
    if (url.hash) {
      ctx.addIssue({ code: "custom", message: "must not have a fragment" });
    }
  });

/**
 * The provider POSTs the logout token from the auth-service host: a URI that
 * points at this machine or its link-local network (loopback, cloud metadata)
 * would turn that delivery into a request to services never meant to be
 * reachable. Internal addresses stay allowed: an internal DNS legitimately
 * answers a private address for a public name. Checked when the URI is saved;
 * the provider does not follow redirects.
 */
export async function assertReachableBackchannelLogoutUri(
  uri: string,
): Promise<void> {
  try {
    await assertNonLocalHost(new URL(uri).hostname);
  } catch (err) {
    throw ERR.APP_001(
      "backchannelLogoutUri must not target this host or a link-local address",
      { reason: err instanceof Error ? err.message : String(err) },
    );
  }
}
