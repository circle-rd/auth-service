/**
 * Finds the favicon of a web page: the icons its `<head>` declares, else
 * `/favicon.ico`. Used to pre-fill the icon of an application from its URL.
 *
 * Every request goes through the SSRF guard (each redirect hop included), is
 * bounded in time and size, and a candidate is only returned once it was seen
 * to answer with an image.
 */

import { assertPublicHost } from "./outbound-guard.js";

const FETCH_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_CANDIDATES = 4;
const USER_AGENT = "auth-service-favicon/1.0";

interface IconCandidate {
  href: string;
  score: number;
}

async function guardedFetch(
  initialUrl: string,
  accept: string,
): Promise<{ res: Response; url: string }> {
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
      headers: { Accept: accept, "User-Agent": USER_AGENT },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("redirect without location");
      await res.body?.cancel();
      url = new URL(location, url).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error("too many redirects");
}

/** The beginning of the body, enough for a `<head>`. */
async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    bytes += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (bytes >= MAX_HTML_BYTES || /<\/head\s*>/i.test(html)) {
      await reader.cancel();
      break;
    }
  }
  return html;
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    out.set(m[1]!.toLowerCase(), (m[2] ?? m[3] ?? m[4] ?? "").trim());
  }
  return out;
}

/** The icons declared by `<link rel="icon">`-style tags, best first, as absolute URLs. */
export function declaredIcons(html: string, pageUrl: string): string[] {
  const head = html.split(/<\/head\s*>/i)[0] ?? html;
  const base = /<base\b[^>]*>/i.exec(head);
  const baseHref = base ? attributes(base[0]).get("href") : undefined;
  const root = baseHref ? new URL(baseHref, pageUrl).toString() : pageUrl;

  const candidates: IconCandidate[] = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attrs.get("href");
    if (!href || href.startsWith("data:")) continue;
    const isIcon = rel.includes("icon");
    const isApple = rel.includes("apple-touch-icon");
    if (!isIcon && !isApple) continue;

    let absolute: string;
    try {
      absolute = new URL(href, root).toString();
    } catch {
      continue;
    }
    const type = (attrs.get("type") ?? "").toLowerCase();
    const sizes = (attrs.get("sizes") ?? "")
      .split(/\s+/)
      .map((s) => (s === "any" ? 512 : Number(s.split("x")[0])))
      .filter((n) => Number.isFinite(n) && n > 0);
    const isSvg = type === "image/svg+xml" || /\.svg(\?|$)/i.test(absolute);
    // A vector scales to any avatar; then the largest raster; the apple icon is a
    // sensible 180 px square; an undeclared size is assumed to be a 16 px ico.
    const score = isSvg
      ? 1000
      : sizes.length > 0
        ? Math.max(...sizes)
        : isApple
          ? 180
          : 16;
    candidates.push({ href: absolute, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return [...new Set(candidates.map((c) => c.href))];
}

async function answersWithAnImage(url: string): Promise<boolean> {
  try {
    const { res } = await guardedFetch(url, "image/*");
    await res.body?.cancel();
    if (!res.ok) return false;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    return type.startsWith("image/") || /\.(ico|svg)(\?|$)/i.test(url);
  } catch {
    return false;
  }
}

/** The favicon URL of `pageUrl`, or null when none can be found. Never throws. */
export async function detectFavicon(pageUrl: string): Promise<string | null> {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return null;

  let declared: string[] = [];
  let origin = page.origin;
  try {
    const { res, url } = await guardedFetch(
      page.toString(),
      "text/html,application/xhtml+xml",
    );
    origin = new URL(url).origin;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (res.ok && (type === "" || type.includes("html"))) {
      declared = declaredIcons(await readHead(res), url);
    } else {
      await res.body?.cancel();
    }
  } catch {
    // An unreachable page may still serve /favicon.ico below.
  }

  for (const candidate of [
    ...declared.slice(0, MAX_CANDIDATES),
    `${origin}/favicon.ico`,
  ]) {
    if (await answersWithAnImage(candidate)) return candidate;
  }
  return null;
}
