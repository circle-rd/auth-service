import { ERR } from "../../errors.js";
import type { ResourceAdapter } from "./types.js";

export const RESOURCE_SCHEME_RE = /^[a-z][a-z0-9]{0,49}$/;
export const RESOURCE_URI_MAX_LENGTH = 512;
export const RESOURCE_LOCATOR_MAX_LENGTH = 255;

// The first segment is an application slug or a user namespace (`u-` plus a
// username of up to 63 characters, underscores included).
const LITELLM_LOCATOR_RE = /^[a-z0-9_-]{1,65}\/[A-Za-z0-9._~:@/-]{1,190}$/;
const MCP_LOCATOR_RE =
  /^[a-z0-9_-]{1,65}\/[A-Za-z0-9._~-]{1,128}(?:\/tool\/[A-Za-z0-9._~-]{1,128})?$/;
const SSH_LOCATOR_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EXTERNAL_LOCATOR_RE = /^[A-Za-z0-9._~:@/-]{1,255}$/;
const FILE_LOCATOR_RE = /^\/[^\0]{1,254}$/;

export interface ParsedResourceUri {
  scheme: string;
  locator: string;
  uri: string;
}

const BUILTIN_ADAPTERS: Readonly<Record<string, ResourceAdapter>> = {
  llm: "litellm",
  agent: "litellm",
  mcp: "litellm",
  ssh: "ssh",
  https: "http",
  file: "file",
};

/**
 * Namespace of the resources a user owns on the gateway. No application slug
 * may start with it (a database check), so the two families never overlap.
 */
export const USER_NAMESPACE_PREFIX = "u-";

export function userNamespace(username: string): string {
  return `${USER_NAMESPACE_PREFIX}${username.toLowerCase()}`;
}

/**
 * The gateway object name a LiteLLM locator stands for. An application-owned
 * locator is `<application slug>/<name>`; a user-owned one already is the name
 * the relay published, `u-<username>/<name>`.
 */
export function gatewayNameOfLocator(locator: string): string | null {
  const separator = locator.indexOf("/");
  if (separator <= 0 || separator === locator.length - 1) return null;
  return locator.startsWith(USER_NAMESPACE_PREFIX)
    ? locator
    : locator.slice(separator + 1);
}

/**
 * LiteLLM model names may hold spaces, which no locator can. The locator carries
 * this projection; the gateway object keeps the real name, which is what the
 * gateway and its entitlements use.
 */
export function litellmLocatorName(name: string): string {
  return name.replace(/\s/g, "_");
}

/**
 * Model names that own their projection. A projection claimed by several names
 * belongs to the one already equal to it (`FRONTIER_Router` over `FRONTIER Router`);
 * when none is, the projection identifies nothing.
 */
export function projectionOwners(names: readonly string[]): Set<string> {
  const byProjection = new Map<string, string[]>();
  for (const name of names) {
    const key = litellmLocatorName(name);
    byProjection.set(key, [...(byProjection.get(key) ?? []), name]);
  }
  const owners = new Set<string>();
  for (const [projection, claimants] of byProjection) {
    if (claimants.length === 1) owners.add(claimants[0]!);
    else if (claimants.includes(projection)) owners.add(projection);
  }
  return owners;
}

export function assertResourceScheme(scheme: string): string {
  if (typeof scheme !== "string" || !RESOURCE_SCHEME_RE.test(scheme)) {
    throw ERR.RES_005("Invalid resource scheme");
  }
  return scheme;
}

export function adapterForScheme(scheme: string): ResourceAdapter {
  assertResourceScheme(scheme);
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_ADAPTERS, scheme)) {
    return "external";
  }
  return BUILTIN_ADAPTERS[scheme] ?? "external";
}

function validHttpsLocator(locator: string): boolean {
  if (locator.length === 0 || /\s/.test(locator)) return false;
  try {
    const url = new URL(`https://${locator}`);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname !== ""
    );
  } catch {
    return false;
  }
}

export function assertLocator(scheme: string, locator: string): string {
  if (
    typeof locator !== "string" ||
    locator.length === 0 ||
    locator.length > RESOURCE_LOCATOR_MAX_LENGTH
  ) {
    throw ERR.RES_005("Invalid resource locator");
  }
  const adapter = adapterForScheme(scheme);
  const valid =
    scheme === "llm" || scheme === "agent"
      ? LITELLM_LOCATOR_RE.test(locator)
      : scheme === "mcp"
        ? MCP_LOCATOR_RE.test(locator)
        : scheme === "ssh"
          ? SSH_LOCATOR_RE.test(locator)
          : scheme === "https"
            ? validHttpsLocator(locator)
            : scheme === "file"
              ? FILE_LOCATOR_RE.test(locator)
              : adapter === "external"
                ? EXTERNAL_LOCATOR_RE.test(locator)
                : false;
  if (!valid) throw ERR.RES_005("Invalid resource locator");
  return locator;
}

export function buildResourceUri(scheme: string, locator: string): string {
  assertResourceScheme(scheme);
  assertLocator(scheme, locator);
  const uri = `${scheme}://${locator}`;
  if (uri.length > RESOURCE_URI_MAX_LENGTH) {
    throw ERR.RES_005("Resource URI is too long");
  }
  return uri;
}

export function parseResourceUri(uri: string): ParsedResourceUri {
  if (
    typeof uri !== "string" ||
    uri.length > RESOURCE_URI_MAX_LENGTH ||
    uri.includes("\0")
  ) {
    throw ERR.RES_005();
  }
  const match = /^([a-z][a-z0-9]{0,49}):\/\/(.+)$/.exec(uri);
  if (!match) throw ERR.RES_005();
  const scheme = match[1] ?? "";
  const locator = match[2] ?? "";
  assertResourceScheme(scheme);
  assertLocator(scheme, locator);
  return { scheme, locator, uri: `${scheme}://${locator}` };
}

export function isResourceUri(value: string): boolean {
  try {
    parseResourceUri(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates the opaque locator used by SSH resources. The URI never exposes the
 * target host; the SSH adapter detail table owns it.
 */
export function newSshLocator(id: string): string {
  assertLocator("ssh", id);
  return id;
}
