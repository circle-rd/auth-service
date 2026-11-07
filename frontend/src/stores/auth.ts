import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { User, Session, MfaMethod } from '@/types';
import {
  getSession,
  signOut as apiSignOut,
  signInEmail as apiSignInEmail,
  verifyTotp as apiVerifyTotp,
  verifyBackupCode as apiVerifyBackupCode,
} from '@/api/auth';
import { authenticateWithPasskey, getMfaMethods } from '@/api/passkeys';
import {
  canAdminTargetUser,
  canManageRole as canManageRoleByRank,
} from '@/utils/roles';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const session = ref<Session | null>(null);
  const loading = ref(false);
  const initialized = ref(false);

  // ── MFA challenge state ──────────────────────────────────────────────────
  // Set when sign-in returns `twoFactorRedirect: true`. The view layer
  // should swap to the MFA challenge form until the user verifies a code.
  const mfaPending = ref(false);
  const mfaMethods = ref<MfaMethod[]>([]);
  const mfaBackupCodesAvailable = ref(false);
  // Signed authorize query carried through the pending MFA challenge, and the
  // OAuth redirect BetterAuth returns once the session cookie is issued.
  const mfaOauthQuery = ref<string | null>(null);
  const mfaResumeUrl = ref<string | null>(null);

  // Indicates the signed-in user must enable a second factor before being
  // allowed to use any downstream application. The auth-service UI itself
  // remains accessible so the user can complete the setup flow.
  const mfaSetupRequired = computed<boolean>(() => {
    if (!user.value) return false;
    return Boolean(user.value.isMfaRequired) && !user.value.twoFactorEnabled;
  });

  async function fetchSession() {
    loading.value = true;
    try {
      const result = await getSession();
      if (result) {
        user.value = result.user;
        session.value = result.session;
      } else {
        user.value = null;
        session.value = null;
      }
    } catch {
      user.value = null;
      session.value = null;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function signInEmail(
    email: string,
    password: string,
    oauthQuery?: string,
  ): Promise<void> {
    mfaOauthQuery.value = oauthQuery ?? null;
    mfaResumeUrl.value = null;
    const result = await apiSignInEmail(email, password, oauthQuery);
    if (result.url) mfaResumeUrl.value = result.url;
    if (result.twoFactorRedirect) {
      let methods = result.twoFactorMethods ?? [];
      if (methods.length === 0) {
        // BetterAuth only knows TOTP/OTP, so it returns [] for a passkey-only
        // account. Offer both fallbacks rather than claiming no method exists.
        methods = ['totp', 'passkey'];
      }
      let backupCodesAvailable = methods.includes('totp');
      try {
        const state = await getMfaMethods();
        methods = state.methods;
        backupCodesAvailable = state.backupCodesAvailable;
      } catch {
        // Keep the fallback; the challenge screen will surface the real error.
      }
      mfaMethods.value = methods;
      mfaBackupCodesAvailable.value = backupCodesAvailable;
      mfaPending.value = true;
      return;
    }
    await fetchSession();
  }

  async function verifyMfaTotp(code: string): Promise<void> {
    const result = await apiVerifyTotp(
      code,
      mfaOauthQuery.value ?? undefined,
    );
    if (result.url) mfaResumeUrl.value = result.url;
    // Refresh the session BEFORE flipping `mfaPending`, otherwise the login
    // view would unmount the challenge form mid-promise and re-render the
    // email/password form for a frame, which the user perceives as a
    // "redirect back to login". The view layer is responsible for calling
    // `clearMfaPending()` after it has navigated away from /login.
    await fetchSession();
    if (!user.value) {
      throw new Error('Session was not established. Please try signing in again.');
    }
  }

  async function verifyMfaBackupCode(code: string): Promise<void> {
    const result = await apiVerifyBackupCode(
      code,
      mfaOauthQuery.value ?? undefined,
    );
    if (result.url) mfaResumeUrl.value = result.url;
    await fetchSession();
    if (!user.value) {
      throw new Error('Session was not established. Please try signing in again.');
    }
  }

  async function verifyMfaPasskey(): Promise<void> {
    const result = await authenticateWithPasskey(
      mfaOauthQuery.value ?? undefined,
    );
    if (result.url) mfaResumeUrl.value = result.url;
    await fetchSession();
    if (!user.value) {
      throw new Error('Session was not established. Please try signing in again.');
    }
  }

  /**
   * Resume a pending second factor after the server-rendered login form handed
   * the user to the SPA. The `two_factor` cookie already proves the password.
   */
  async function resumeMfaChallenge(oauthQuery?: string): Promise<boolean> {
    mfaOauthQuery.value = oauthQuery ?? null;
    try {
      const methods = await getMfaMethods();
      mfaMethods.value = methods.methods;
      mfaBackupCodesAvailable.value = methods.backupCodesAvailable;
      mfaPending.value = true;
      return true;
    } catch {
      mfaPending.value = false;
      mfaMethods.value = [];
      mfaBackupCodesAvailable.value = false;
      return false;
    }
  }

  function clearMfaPending(): void {
    mfaPending.value = false;
    mfaMethods.value = [];
    mfaBackupCodesAvailable.value = false;
    mfaOauthQuery.value = null;
    mfaResumeUrl.value = null;
  }

  function cancelMfa(): void {
    mfaPending.value = false;
    mfaMethods.value = [];
    mfaBackupCodesAvailable.value = false;
    mfaOauthQuery.value = null;
    mfaResumeUrl.value = null;
  }

  async function logout() {
    try {
      await apiSignOut();
    } catch {
      // proceed even if API fails (e.g. session already expired)
    }
    user.value = null;
    session.value = null;
    mfaPending.value = false;
    mfaMethods.value = [];
    mfaBackupCodesAvailable.value = false;
  }

  function isAdmin(): boolean {
    return user.value?.role === 'admin' || user.value?.role === 'superadmin';
  }

  function isSuperAdmin(): boolean {
    return user.value?.role === 'superadmin';
  }

  /**
   * Mirrors the server's admin-route policy: a superadmin may manage anyone; an
   * admin may only manage non-admin users. Used to hide actions the caller
   * cannot perform.
   *
   * Delegates to the shared rank table (`@/utils/roles`) instead of re-writing
   * the comparison, so this gate cannot drift from `canAdminTargetUser`.
   */
  function canManageUser(targetRole: string | null | undefined): boolean {
    return canAdminTargetUser(user.value?.role, targetRole);
  }

  /**
   * STRICT policy, for the actions the server guards with `canManageRole` — the
   * password reset in particular. A superadmin may NOT act on a peer, so this
   * deliberately does not answer the same as `canManageUser`.
   */
  function canManageRole(targetRole: string | null | undefined): boolean {
    return canManageRoleByRank(user.value?.role, targetRole);
  }

  return {
    user,
    session,
    loading,
    initialized,
    mfaPending,
    mfaMethods,
    mfaBackupCodesAvailable,
    mfaOauthQuery,
    mfaResumeUrl,
    mfaSetupRequired,
    fetchSession,
    signInEmail,
    verifyMfaTotp,
    verifyMfaBackupCode,
    verifyMfaPasskey,
    resumeMfaChallenge,
    clearMfaPending,
    cancelMfa,
    logout,
    isAdmin,
    isSuperAdmin,
    canManageUser,
    canManageRole,
  };
});
