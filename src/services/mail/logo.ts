/**
 * Resolves `APP_LOGO_URL` into an inline (CID) email attachment so the logo is
 * embedded in the message and clients never fetch an external URL.
 *
 * Supported sources:
 *   - `data:image/...;base64,...` and URL-encoded data URIs
 *   - `http(s)://...` — fetched once and cached (best effort)
 *
 * Security / reliability:
 *   - the destination host is resolved and loopback/private/link-local
 *     addresses are rejected (basic SSRF guard);
 *   - redirects are followed manually and each hop is re-validated;
 *   - the body is capped at `MAX_LOGO_BYTES`.
 *
 * Resolution never blocks a mail send: `ensureLogoAttachmentWarmed()` fills the
 * cache (deduplicated across concurrent callers) while `getCachedLogoAttachment()`
 * returns whatever is currently cached, so a cold/expired cache falls back to
 * the text wordmark for that message.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { MailAttachment } from "./types.js";

/** CID referenced from the templates as `cid:app-logo`. */
export const LOGO_CID = "app-logo";

const CACHE_TTL_MS = 60 * 60_000;
const MAX_LOGO_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;
const FETCH_TIMEOUT_MS = 3_000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

let cached: { attachment: MailAttachment | null; at: number } | null = null;
let inflight: Promise<MailAttachment | null> | null = null;

function extensionFor(contentType: string, ext: string): string {
  if (MIME_BY_EXT[ext]) return ext;
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/svg+xml") return ".svg";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/webp") return ".webp";
  return ".png";
}

function attachmentFromBytes(
  content: Buffer,
  contentType: string,
  ext: string,
): MailAttachment | null {
  if (content.byteLength === 0 || content.byteLength > MAX_LOGO_BYTES) {
    return null;
  }
  return {
    filename: `logo${extensionFor(contentType, ext)}`,
    content,
    cid: LOGO_CID,
    contentType,
  };
}

function fromDataUri(url: string): MailAttachment | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) return null;
  const contentType = match[1] ?? "";
  if (!contentType.startsWith("image/")) return null;
  const raw = match[3] ?? "";
  // Reject oversized payloads before decoding the whole string.
  if (raw.length > MAX_LOGO_BYTES * 2) return null;
  const content = match[2]
    ? Buffer.from(raw, "base64")
    : Buffer.from(decodeURIComponent(raw), "utf8");
  return attachmentFromBytes(content, contentType, "");
}

// ── SSRF guard ──────────────────────────────────────────────────────────────

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

async function assertPublicHost(hostname: string): Promise<void> {
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

// ── Fetching ────────────────────────────────────────────────────────────────

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_LOGO_BYTES) throw new Error("logo exceeds size limit");

  const body = res.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_LOGO_BYTES) {
      await reader.cancel();
      throw new Error("logo exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fromRemote(initialUrl: string): Promise<MailAttachment | null> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    await assertPublicHost(parsed.hostname);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("redirect without location");
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const headerType = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim();
    const ext = extname(parsed.pathname).toLowerCase();
    const contentType = headerType.startsWith("image/")
      ? headerType
      : (MIME_BY_EXT[ext] ?? "");
    if (!contentType.startsWith("image/")) return null;

    const content = await readCapped(res);
    return attachmentFromBytes(content, contentType, ext);
  }
  throw new Error("too many redirects");
}

async function fetchLogoAttachment(): Promise<MailAttachment | null> {
  const url = config.appLogoUrl;
  if (!url) return null;
  try {
    if (url.startsWith("data:")) return fromDataUri(url);
    if (/^https?:\/\//i.test(url)) return await fromRemote(url);
    const ext = extname(url).toLowerCase();
    const contentType = MIME_BY_EXT[ext];
    if (!contentType) return null;
    return attachmentFromBytes(readFileSync(url), contentType, ext);
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "[mail] could not resolve APP_LOGO_URL; using text wordmark",
    );
    return null;
  }
}

/**
 * Populate the logo cache if it is empty or stale. Concurrent callers share a
 * single in-flight request. Never throws.
 */
export function ensureLogoAttachmentWarmed(): Promise<MailAttachment | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.attachment);
  }
  if (!inflight) {
    inflight = fetchLogoAttachment()
      .then((attachment) => {
        cached = { attachment, at: Date.now() };
        return attachment;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * The currently cached logo, or null when absent/stale. Synchronous so a mail
 * send never waits on the network; the caller should also call
 * `ensureLogoAttachmentWarmed()` to refresh in the background.
 */
export function getCachedLogoAttachment(): MailAttachment | null {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.attachment;
  return null;
}
