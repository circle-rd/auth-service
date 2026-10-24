import { z } from "zod";

export const COMPAT_PROFILES = [
  "default",
  "okta",
  "auth0",
  "keycloak",
  "custom",
] as const;
export type CompatProfile = (typeof COMPAT_PROFILES)[number];

export const TOKEN_AUTH_METHODS = ["basic", "post"] as const;
export type TokenAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];

export const SIGNING_ALGS = ["EdDSA", "RS256"] as const;
export type SigningAlg = (typeof SIGNING_ALGS)[number];

export const ALIAS_SETS = ["okta", "auth0"] as const;
export type AliasSet = (typeof ALIAS_SETS)[number];

// A mapping copies a value that auth-service already computes into a claim
// whose name another identity provider uses. There is deliberately no
// expression language: the sources are a closed list.
export const CLAIM_SOURCES = [
  "roles",
  "permissions",
  "scope",
  "email",
  "clientId",
] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

// Claims that the token itself owns; a mapping can never overwrite them.
const PROTECTED_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "azp",
  "client_id",
  "scope",
  "sid",
  "auth_time",
  "nonce",
  "at_hash",
]);

export const claimMappingSchema = z.object({
  claim: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z_][A-Za-z0-9_:/.-]*$/, "invalid claim name")
    .refine((name) => !PROTECTED_CLAIMS.has(name), "reserved claim name"),
  source: z.enum(CLAIM_SOURCES),
  // The claim is emitted only when this scope was requested.
  scope: z.string().min(1).optional(),
});
export type ClaimMapping = z.infer<typeof claimMappingSchema>;

export const claimMappingsSchema = z.array(claimMappingSchema).max(20);

export interface CompatSettings {
  profile: CompatProfile;
  tokenAuthMethod: TokenAuthMethod;
  signingAlg: SigningAlg;
  /** Issue a JWT access token even when the request carries no `resource`. */
  defaultAudience: boolean;
  /** Accept `audience` as an alias of `resource` (Auth0 clients send it). */
  audienceParam: boolean;
  claimMappings: ClaimMapping[];
  aliases: AliasSet[];
}

type Preset = Omit<CompatSettings, "profile">;

const NO_PRESET: Preset = {
  tokenAuthMethod: "basic",
  signingAlg: "EdDSA",
  defaultAudience: false,
  audienceParam: false,
  claimMappings: [],
  aliases: [],
};

const PRESETS: Record<Exclude<CompatProfile, "custom">, Preset> = {
  default: NO_PRESET,
  okta: {
    tokenAuthMethod: "basic",
    signingAlg: "RS256",
    defaultAudience: true,
    audienceParam: false,
    claimMappings: [
      { claim: "groups", source: "roles", scope: "groups" },
      { claim: "scp", source: "scope" },
      { claim: "preferred_username", source: "email", scope: "profile" },
      { claim: "cid", source: "clientId" },
    ],
    aliases: ["okta"],
  },
  auth0: {
    tokenAuthMethod: "post",
    signingAlg: "RS256",
    defaultAudience: false,
    audienceParam: true,
    claimMappings: [],
    aliases: ["auth0"],
  },
  keycloak: {
    tokenAuthMethod: "basic",
    signingAlg: "RS256",
    defaultAudience: true,
    audienceParam: false,
    claimMappings: [
      { claim: "groups", source: "roles", scope: "roles" },
      { claim: "preferred_username", source: "email", scope: "profile" },
    ],
    aliases: [],
  },
};

export interface CompatOverrides {
  profile: CompatProfile;
  tokenAuthMethod?: TokenAuthMethod | undefined;
  signingAlg?: SigningAlg | undefined;
  defaultAudience?: boolean | undefined;
  audienceParam?: boolean | undefined;
  claimMappings?: ClaimMapping[] | undefined;
  aliases?: AliasSet[] | undefined;
}

/**
 * Resolve the instance-wide compatibility settings: the profile supplies the
 * defaults and every explicit variable wins over it. `custom` starts from the
 * plain defaults so that nothing but what the operator sets is changed.
 */
export function resolveCompat(input: CompatOverrides): CompatSettings {
  const base = input.profile === "custom" ? NO_PRESET : PRESETS[input.profile];
  return {
    profile: input.profile,
    tokenAuthMethod: input.tokenAuthMethod ?? base.tokenAuthMethod,
    signingAlg: input.signingAlg ?? base.signingAlg,
    defaultAudience: input.defaultAudience ?? base.defaultAudience,
    audienceParam: input.audienceParam ?? base.audienceParam,
    claimMappings: input.claimMappings ?? base.claimMappings,
    aliases: input.aliases ?? base.aliases,
  };
}

/** Scopes used by claim mappings that the server does not already support. */
export function compatExtraScopes(
  settings: CompatSettings,
  nativeScopes: readonly string[],
): string[] {
  const native = new Set(nativeScopes);
  return [
    ...new Set(
      settings.claimMappings
        .map((m) => m.scope)
        .filter((s): s is string => s !== undefined && !native.has(s)),
    ),
  ];
}
