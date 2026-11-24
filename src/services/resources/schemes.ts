import { ERR } from "../../errors.js";
import {
  RESOURCE_PERMISSIONS,
  type ResourceAdapter,
  type ResourcePermission,
} from "./types.js";
import { assertResourceScheme } from "./uri.js";

export interface BuiltinScheme {
  scheme: string;
  adapter: ResourceAdapter;
  displayName: string;
  description: string;
  icon: string;
  environmentFlag: string;
  validatorClientId: string | null;
  // A single-action scheme supports only `read`, which then means "use".
  permissions: readonly ResourcePermission[];
}

/**
 * Built-in schemes are the platform-owned resource families. Their metadata is
 * code-defined so they cannot drift between deployments; the database row is a
 * mirror used for foreign keys and UI queries.
 */
export const BUILTIN_SCHEMES = [
  {
    scheme: "llm",
    adapter: "litellm",
    displayName: "Model",
    description: "A model served by the LiteLLM gateway.",
    icon: "model",
    environmentFlag: "RESOURCE_SCHEMES_ENABLED",
    validatorClientId: "litellm",
    permissions: ["read"],
  },
  {
    scheme: "agent",
    adapter: "litellm",
    displayName: "AI agent",
    description: "An A2A agent served by the LiteLLM gateway.",
    icon: "agent",
    environmentFlag: "RESOURCE_SCHEMES_ENABLED",
    validatorClientId: "litellm",
    permissions: ["read"],
  },
  {
    scheme: "mcp",
    adapter: "litellm",
    displayName: "MCP server",
    description: "An MCP server or one of its tools.",
    icon: "mcp",
    environmentFlag: "RESOURCE_SCHEMES_ENABLED",
    validatorClientId: "litellm",
    permissions: ["read"],
  },
  {
    scheme: "ssh",
    adapter: "ssh",
    displayName: "SSH host",
    description: "An SSH account shared through the SSH gateway.",
    icon: "terminal",
    environmentFlag: "RESOURCE_SCHEMES_ENABLED",
    validatorClientId: "ssh-gateway",
    permissions: ["read"],
  },
  {
    scheme: "https",
    adapter: "http",
    displayName: "HTTP endpoint",
    description: "A reserved HTTP endpoint resource.",
    icon: "globe",
    environmentFlag: "RESOURCE_SCHEMES_ENABLED",
    validatorClientId: "http-proxy",
    permissions: ["read"],
  },
  {
    scheme: "file",
    adapter: "file",
    displayName: "File",
    description: "A reserved file resource.",
    icon: "file",
    environmentFlag: "RESOURCE_SCHEMES_ENABLED",
    validatorClientId: "file-service",
    permissions: ["read", "write"],
  },
] as const satisfies readonly BuiltinScheme[];

export const BUILTIN_SCHEME_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SCHEMES.map((entry) => entry.scheme),
);

export function isBuiltinScheme(scheme: string): boolean {
  return BUILTIN_SCHEME_NAMES.has(scheme);
}

export function builtinScheme(scheme: string): BuiltinScheme | undefined {
  return BUILTIN_SCHEMES.find((entry) => entry.scheme === scheme);
}

/** Application-defined schemes act on their own resources, so both levels apply. */
export function supportedPermissions(
  scheme: string,
): readonly ResourcePermission[] {
  return builtinScheme(scheme)?.permissions ?? RESOURCE_PERMISSIONS;
}

export function assertPermissionSupported(
  scheme: string,
  permission: ResourcePermission,
): void {
  if (!supportedPermissions(scheme).includes(permission)) {
    throw ERR.RES_014(
      `The ${scheme} scheme does not support the ${permission} permission`,
    );
  }
}

export function assertApplicationSchemeName(scheme: string): string {
  assertResourceScheme(scheme);
  if (isBuiltinScheme(scheme)) {
    throw ERR.RES_001("Built-in resource schemes cannot be registered");
  }
  return scheme;
}

export interface BuiltinSchemeRow {
  scheme: string;
  source: "builtin";
  adapter: ResourceAdapter;
  ownerType: "platform";
  ownerId: null;
  displayName: string;
  description: string;
  icon: string;
  status: "active" | "disabled";
  validatorClientId: string | null;
  config: Record<string, unknown>;
}

export function builtinSchemeRows(
  enabledSchemes: readonly string[],
): BuiltinSchemeRow[] {
  const enabled = new Set(enabledSchemes);
  return BUILTIN_SCHEMES.map((entry) => ({
    scheme: entry.scheme,
    source: "builtin" as const,
    adapter: entry.adapter,
    ownerType: "platform" as const,
    ownerId: null,
    displayName: entry.displayName,
    description: entry.description,
    icon: entry.icon,
    status: enabled.has(entry.scheme)
      ? ("active" as const)
      : ("disabled" as const),
    validatorClientId: entry.validatorClientId,
    config: {},
  }));
}
