import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Short-lived, signed invitation token that ties a social sign-in to the
 * invitation that authorised it. The social-start route injects it into the
 * internal `/sign-in/social` request; the auth hook copies it into BetterAuth's
 * server-trusted OAuth state, which the provider callback reads back. No
 * browser cookie is used, so a callback cannot drop the binding.
 */
export const INVITATION_FLOW_COOKIE = "auth_invitation_flow";

/** The invitation flow is only useful across one provider round-trip. */
const INVITATION_FLOW_TTL_SECONDS = 10 * 60;

export type InvitationKind = "organization" | "application";

export interface InvitationFlow {
  kind: InvitationKind;
  invitationId: string;
  email: string;
  exp: number;
}

function sign(value: string): string {
  return createHmac("sha256", config.betterAuth.secret)
    .update(value)
    .digest("base64url");
}

export function createInvitationFlowValue(flow: {
  kind: InvitationKind;
  invitationId: string;
  email: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...flow,
      email: flow.email.trim().toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + INVITATION_FLOW_TTL_SECONDS,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function isInvitationKind(value: unknown): value is InvitationKind {
  return value === "organization" || value === "application";
}

/**
 * Narrow a value that came from a trusted container (a signed flow payload
 * or BetterAuth's server-side OAuth state) into an invitation flow.
 */
export function toInvitationFlow(value: unknown): InvitationFlow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isInvitationKind(record.kind)) return null;
  if (typeof record.invitationId !== "string" || record.invitationId === "") {
    return null;
  }
  if (typeof record.email !== "string" || record.email === "") return null;
  if (typeof record.exp !== "number" || record.exp <= 0) return null;
  return {
    kind: record.kind,
    invitationId: record.invitationId,
    email: record.email.trim().toLowerCase(),
    exp: record.exp,
  };
}

/**
 * Verify and decode a cookie value. Rejects forged signatures, malformed
 * payloads, missing fields and expired flows.
 */
export function parseInvitationFlowValue(
  value: string,
  now: Date = new Date(),
): InvitationFlow | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = sign(payload);
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return null;
  if (!timingSafeEqual(actual, wanted)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const flow = toInvitationFlow(parsed);
  if (!flow) return null;
  if (flow.exp <= Math.floor(now.getTime() / 1000)) return null;
  return flow;
}

function rawCookieHeader(headers: unknown): string | null {
  if (!headers) return null;
  if (
    typeof headers === "object" &&
    "get" in headers &&
    typeof (headers as Headers).get === "function"
  ) {
    return (headers as Headers).get("cookie");
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        entry[0].toLowerCase() === "cookie" &&
        typeof entry[1] === "string"
      ) {
        return entry[1];
      }
    }
    return null;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (key.toLowerCase() === "cookie" && typeof value === "string") {
        return value;
      }
    }
  }
  return null;
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Read and verify the invitation flow carried by an internal request. */
export function readInvitationFlow(headers: unknown): InvitationFlow | null {
  const cookie = rawCookieHeader(headers);
  if (!cookie) return null;
  const value = readCookie(cookie, INVITATION_FLOW_COOKIE);
  return value ? parseInvitationFlowValue(value) : null;
}
