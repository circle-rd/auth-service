import type { Application } from '@/types';

export const ALL_PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;
export type ProviderKey = (typeof ALL_PROVIDERS)[number];

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'roles', 'permissions', 'features'];

// Server-enforced identifier shape of the metadata keys.
const METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface MetadataEntry {
  key: string;
  value: string;
}

export interface ApplicationFormState {
  name: string;
  slug: string;
  description: string;
  url: string;
  icon: string;
  isActive: boolean;
  isPublic: boolean;
  skipConsent: boolean;
  isMfaRequired: boolean;
  allowRegister: boolean;
  billingDelegated: boolean;
  allowedScopes: string[];
  redirectUris: string[];
  allowedResources: string[];
  // null = inherit every globally enabled provider.
  enabledSocialProviders: string[] | null;
  // OIDC RP-Initiated Logout: off unless the application must end the central SSO session.
  enableEndSession: boolean;
  postLogoutRedirectUris: string[];
  // OIDC Back-Channel Logout endpoint (public https); empty = not supported.
  backchannelLogoutUri: string;
  // Confidential client: whether the code flow requires PKCE, and how the
  // client authenticates to the token endpoint.
  requirePKCE: boolean;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  // Edited as ordered pairs, serialized to a plain Record<string, string> on submit.
  metadata: MetadataEntry[];
}

export function emptyApplicationForm(): ApplicationFormState {
  return {
    name: '',
    slug: '',
    description: '',
    url: '',
    icon: '',
    isActive: true,
    isPublic: false,
    skipConsent: false,
    isMfaRequired: false,
    allowRegister: true,
    billingDelegated: false,
    allowedScopes: [...DEFAULT_SCOPES],
    redirectUris: [''],
    allowedResources: [],
    enabledSocialProviders: null,
    enableEndSession: false,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: '',
    requirePKCE: true,
    tokenEndpointAuthMethod: 'client_secret_basic',
    metadata: [],
  };
}

export function formFromApplication(a: Application): ApplicationFormState {
  return {
    name: a.name,
    slug: a.slug,
    description: a.description ?? '',
    url: a.url ?? '',
    icon: a.icon ?? '',
    isActive: a.isActive,
    isPublic: a.isPublic,
    skipConsent: a.skipConsent,
    isMfaRequired: a.isMfaRequired,
    allowRegister: a.allowRegister,
    billingDelegated: a.billingMode === 'delegated',
    allowedScopes: [...a.allowedScopes],
    redirectUris: a.redirectUris.length ? [...a.redirectUris] : [''],
    allowedResources: [...(a.allowedResources ?? [])],
    enabledSocialProviders: a.enabledSocialProviders ? [...a.enabledSocialProviders] : null,
    enableEndSession: a.enableEndSession ?? false,
    postLogoutRedirectUris: a.postLogoutRedirectUris ? [...a.postLogoutRedirectUris] : [],
    backchannelLogoutUri: a.backchannelLogoutUri ?? '',
    requirePKCE: a.requirePKCE ?? true,
    tokenEndpointAuthMethod:
      a.tokenEndpointAuthMethod === 'client_secret_post'
        ? 'client_secret_post'
        : 'client_secret_basic',
    metadata: Object.entries(a.metadata ?? {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}

export function isMetadataKeyValid(key: string): boolean {
  return key === '' || METADATA_KEY_RE.test(key);
}

export function metadataDuplicateKeys(entries: MetadataEntry[]): Set<string> {
  const seen = new Map<string, number>();
  for (const { key } of entries) {
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}

export function metadataHasError(entries: MetadataEntry[]): boolean {
  if (metadataDuplicateKeys(entries).size > 0) return true;
  // Empty rows are dropped on submit, but a row with only one side filled is an error.
  return entries.some(({ key, value }) => (key === '' && value !== '') || !isMetadataKeyValid(key));
}
