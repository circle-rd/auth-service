/**
 * SSRF guard for outbound requests whose destination an administrator chooses
 * (the application logo, the favicon of an application's URL, a back-channel
 * logout endpoint): the host is resolved and the addresses the policy refuses
 * are rejected. Callers following redirects must call it again on every hop.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// `local` addresses never leave the machine or its link (loopback, unspecified,
// link-local including cloud metadata, multicast and reserved). `private` ones
// are internal networks, which an internal deployment legitimately resolves to.
function isLocalIPv4(a: number, b: number): boolean {
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
}

function isPrivateIPv4(a: number, b: number, c: number): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isBlockedIPv4(ip: string, allowPrivate: boolean): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (isLocalIPv4(a, b)) return true;
  return !allowPrivate && isPrivateIPv4(a, b, c);
}

function isBlockedAddress(ip: string, allowPrivate: boolean): boolean {
  if (isIP(ip) === 4) return isBlockedIPv4(ip, allowPrivate);
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  if (!allowPrivate && (lower.startsWith("fc") || lower.startsWith("fd"))) {
    return true; // fc00::/7
  }
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isBlockedIPv4(v4, allowPrivate);
  }
  return false;
}

async function assertHost(
  hostname: string,
  allowPrivate: boolean,
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (!allowPrivate && (host.endsWith(".local") || host.endsWith(".internal")))
  ) {
    throw new Error(`blocked host: ${host}`);
  }
  if (isIP(host)) {
    if (isBlockedAddress(host, allowPrivate)) {
      throw new Error(`blocked address: ${host}`);
    }
    return;
  }
  const resolved = await lookup(host, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error(`unresolvable host: ${host}`);
  for (const { address } of resolved) {
    if (isBlockedAddress(address, allowPrivate)) {
      throw new Error(`blocked address for ${host}: ${address}`);
    }
  }
}

/** Public internet only: loopback, local and private networks are refused. */
export function assertPublicHost(hostname: string): Promise<void> {
  return assertHost(hostname, false);
}

/**
 * Any host but this machine and its link: internal addresses stay allowed,
 * because an internal DNS may legitimately answer a private address for a
 * public name (split-horizon deployments).
 */
export function assertNonLocalHost(hostname: string): Promise<void> {
  return assertHost(hostname, true);
}
