/**
 * SSRF guard for outbound requests whose destination an administrator chooses
 * (the application logo, the favicon of an application's URL): the host is
 * resolved and loopback, private, link-local and similar addresses are refused.
 * Callers following redirects must call it again on every hop.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isBlockedIPv4(ip);
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isBlockedIPv4(v4);
  }
  return false;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`blocked host: ${host}`);
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`blocked address: ${host}`);
    return;
  }
  const resolved = await lookup(host, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error(`unresolvable host: ${host}`);
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new Error(`blocked address for ${host}: ${address}`);
    }
  }
}
