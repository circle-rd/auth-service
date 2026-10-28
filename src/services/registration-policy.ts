import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { config } from "../config.js";

/** The `client_id` an OAuth or confirmation callback carries, if any. */
export function clientIdOf(callbackURL: unknown): string | null {
  if (typeof callbackURL !== "string" || callbackURL === "") return null;
  try {
    return (
      new URL(callbackURL, config.betterAuth.url).searchParams.get(
        "client_id",
      ) || null
    );
  } catch {
    return null;
  }
}

/** The `client_id` of the application a BetterAuth email link was issued for. */
export function clientIdOfLink(link: string): string | null {
  try {
    return clientIdOf(new URL(link).searchParams.get("callbackURL"));
  } catch {
    return null;
  }
}

/**
 * Whether a sign-up arriving with this `callbackURL` may create an account.
 *
 * Registration belongs to applications, not to the service itself: it is open
 * only when the callback names (`client_id`) an existing application that allows
 * it. The sign-in pages of an application pass its authorization URL as the
 * callback, so its sign-up carries the client id.
 */
export async function registrationOpenFor(
  callbackURL: unknown,
): Promise<boolean> {
  const clientId = clientIdOf(callbackURL);
  if (!clientId) return false;
  const [app] = await db
    .select({ allowRegister: applications.allowRegister })
    .from(applications)
    .where(eq(applications.slug, clientId))
    .limit(1);
  return app?.allowRegister === true;
}
