/**
 * Multi-factor authentication enforcement helpers.
 *
 * The TOTP and backup-code flows themselves are fully implemented by
 * BetterAuth's `twoFactor` plugin. These helpers exist to enforce per-user and
 * per-application MFA requirements at OAuth token-issuance time.
 */

export interface MfaUserState {
  isMfaRequired: boolean;
  twoFactorEnabled: boolean;
}

/**
 * Coerce loosely-typed BetterAuth user objects into the boolean state we need.
 * BetterAuth returns `additionalFields` as `Record<string, unknown>` because
 * they are dynamically declared in the `auth.ts` config.
 */
export function readMfaState(user: Record<string, unknown>): MfaUserState {
  return {
    isMfaRequired: Boolean(user.isMfaRequired),
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
  };
}

/**
 * Returns true when the user must enable a second factor before being granted
 * access to a downstream application via OAuth.
 *
 * `appRequiresMfa` is the per-application flag (`applications.is_mfa_required`).
 * Either flag being set is sufficient to require MFA.
 */
export function userMustSetupMfa(
  user: Record<string, unknown>,
  appRequiresMfa: boolean,
): boolean {
  const state = readMfaState(user);
  if (state.twoFactorEnabled) return false;
  return appRequiresMfa || state.isMfaRequired;
}
