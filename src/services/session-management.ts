import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { session } from "../db/auth-schema.js";

const STATE_TTL_SECONDS = 60 * 60 * 24 * 7;

interface SessionStatePayload {
  /** Session row id (never the session token). */
  s: string;
  /** OAuth client id. */
  c: string;
  /** Origin of the client's redirect URI. */
  o: string;
  exp: number;
}

export type SessionStatus = "unchanged" | "changed" | "error";

function hmac(payload: string): string {
  return createHmac("sha256", config.betterAuth.secret)
    .update(payload)
    .digest("base64url");
}

export function createSessionState(
  sessionId: string,
  clientId: string,
  origin: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      s: sessionId,
      c: clientId,
      o: origin,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    } satisfies SessionStatePayload),
  ).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

function parseSessionState(value: string): SessionStatePayload | null {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;

  const expected = Buffer.from(hmac(payload));
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const state = parsed as Partial<SessionStatePayload>;
  if (
    typeof state.s !== "string" ||
    typeof state.c !== "string" ||
    typeof state.o !== "string" ||
    typeof state.exp !== "number" ||
    state.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return state as SessionStatePayload;
}

async function isSessionActive(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.id, sessionId))
    .limit(1);
  return row !== undefined && row.expiresAt.getTime() > Date.now();
}

/**
 * Resolve the session-management status for a check_session_iframe message.
 * The signed payload binds the opaque state to one client and one RP origin,
 * so a state value cannot be replayed by another client or origin.
 */
export async function checkSessionState(
  clientId: string,
  origin: string,
  value: string,
): Promise<SessionStatus> {
  const state = parseSessionState(value);
  if (!state || state.c !== clientId || state.o !== origin) return "error";
  return (await isSessionActive(state.s)) ? "unchanged" : "changed";
}

export function appendSessionState(
  location: string,
  sessionState: string,
): string {
  try {
    const url = new URL(location);
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
      return location;
    }
    url.searchParams.set("session_state", sessionState);
    return url.toString();
  } catch {
    return location;
  }
}

export function checkSessionIframeHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>OP Session Management</title></head>
<body>
<script>
(function () {
  function parse(data) {
    if (typeof data === "string") {
      var i = data.indexOf(" ");
      if (i <= 0) return null;
      return { client_id: data.slice(0, i), session_state: data.slice(i + 1) };
    }
    if (data && typeof data === "object" && typeof data.client_id === "string" && typeof data.session_state === "string") {
      return { client_id: data.client_id, session_state: data.session_state };
    }
    return null;
  }
  window.addEventListener("message", function (event) {
    var message = parse(event.data);
    if (!message || !event.source) return;
    var url = "/check_session_state?client_id=" + encodeURIComponent(message.client_id) +
      "&origin=" + encodeURIComponent(event.origin) +
      "&session_state=" + encodeURIComponent(message.session_state);
    fetch(url, { cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        var status = result.status === "unchanged" || result.status === "changed" ? result.status : "error";
        event.source.postMessage(status, event.origin);
      })
      .catch(function () {
        event.source.postMessage("error", event.origin);
      });
  }, false);
})();
</script>
</body>
</html>`;
}
