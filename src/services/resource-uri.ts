import { ERR } from "../errors.js";

export const RESOURCE_TYPES = [
  "model",
  "workflow",
  "mcp_agent",
  "https_endpoint",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

const SCHEME_ADAPTERS = [
  { resourceType: "model", scheme: "llm" },
  { resourceType: "workflow", scheme: "workflow" },
  { resourceType: "mcp_agent", scheme: "mcpagent" },
  { resourceType: "https_endpoint", scheme: "api" },
] as const satisfies readonly {
  resourceType: ResourceType;
  scheme: string;
}[];

export type ResourceSchemeAdapter = (typeof SCHEME_ADAPTERS)[number];

const SCHEME_BY_TYPE = new Map<ResourceType, string>(
  SCHEME_ADAPTERS.map((a) => [a.resourceType, a.scheme]),
);
const TYPE_BY_SCHEME = new Map<string, ResourceType>(
  SCHEME_ADAPTERS.map((a) => [a.scheme, a.resourceType]),
);

const OWNER_RE = /^[a-z0-9-]{1,64}$/;
const SLUG_RE = /^(?=.*[a-z0-9])[a-z0-9-]{1,64}$/;

export interface ResourceKeyParts {
  owner: string;
  slug: string;
  key: string;
}

export interface ParsedResourceUri extends ResourceKeyParts {
  resourceType: ResourceType;
  scheme: string;
  uri: string;
}

function invalid(): never {
  throw ERR.RES_005();
}

export function normalizeResourceSlug(slug: string): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) invalid();
  return slug;
}

/** Canonical `<owner>/<slug>`; rejects URIs, uppercase, traversal and extras. */
export function normalizeResourceKey(input: string): ResourceKeyParts {
  if (typeof input !== "string" || input === "" || input.includes("://")) {
    invalid();
  }
  const parts = input.split("/");
  if (parts.length !== 2) invalid();
  const [owner = "", slug = ""] = parts;
  if (!OWNER_RE.test(owner) || !SLUG_RE.test(slug)) invalid();
  return { owner, slug, key: `${owner}/${slug}` };
}

export function resourceTypeForScheme(
  scheme: string,
): ResourceType | undefined {
  return TYPE_BY_SCHEME.get(scheme);
}

export function schemeForResourceType(type: ResourceType): string {
  const scheme = SCHEME_BY_TYPE.get(type);
  if (!scheme) invalid();
  return scheme;
}

export function formatResourceUri(type: ResourceType, key: string): string {
  const parts = normalizeResourceKey(key);
  return `${schemeForResourceType(type)}://${parts.key}`;
}

export function parseResourceUri(uri: string): ParsedResourceUri {
  if (typeof uri !== "string") invalid();
  const match = /^([a-z][a-z0-9-]*):\/\/(.+)$/.exec(uri);
  if (!match) invalid();
  const scheme = match[1] ?? "";
  const resourceType = resourceTypeForScheme(scheme);
  if (!resourceType) invalid();
  const parts = normalizeResourceKey(match[2] ?? "");
  return { ...parts, resourceType, scheme, uri };
}
