export type ScopeGroup = 'standard' | 'circle';

export interface ScopeInfo {
  scope: string;
  group: ScopeGroup;
  // What the scope adds to the tokens, as shown in the integration reference.
  claims: string;
  // Not picked by hand: another option of the form owns it (LiteLLM support).
  managed?: true;
}

export const WALLET_SCOPE = 'wallet:self:read';

export const SCOPE_CATALOGUE: readonly ScopeInfo[] = [
  { scope: 'openid', group: 'standard', claims: 'sub, iss, aud, exp, iat, jti' },
  { scope: 'profile', group: 'standard', claims: 'name, picture, company*, updated_at' },
  { scope: 'email', group: 'standard', claims: 'email, email_verified' },
  { scope: 'phone', group: 'standard', claims: 'phone_number' },
  { scope: 'offline_access', group: 'standard', claims: '(enables refresh token)' },
  { scope: 'roles', group: 'circle', claims: 'roles[]' },
  { scope: 'permissions', group: 'circle', claims: 'permissions[]' },
  { scope: 'features', group: 'circle', claims: 'features{}, plan' },
  { scope: 'org', group: 'circle', claims: 'org_id' },
  { scope: WALLET_SCOPE, group: 'circle', claims: '(authorizes the user wallet API)', managed: true },
];

export const SCOPE_GROUPS: readonly ScopeGroup[] = ['standard', 'circle'];

export function selectableScopes(group: ScopeGroup): ScopeInfo[] {
  return SCOPE_CATALOGUE.filter((s) => s.group === group && !s.managed);
}
