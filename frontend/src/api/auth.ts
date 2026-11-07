import { apiFetch, USE_MOCK } from './client';
import type { User, Session, MfaSetupResult, MfaBackupCodesResult, SignInResult } from '@/types';
import { MOCK_CURRENT_USER, MOCK_SESSIONS } from '@/mocks/data';

export interface AuthSession {
  user: User
  session: Session
}

export async function signOut(): Promise<void> {
  if (USE_MOCK) return;
  await apiFetch('/auth/sign-out', { method: 'POST' });
}

export async function getSession(): Promise<AuthSession | null> {
  if (USE_MOCK) {
    return {
      user: MOCK_CURRENT_USER,
      session: MOCK_SESSIONS[0],
    };
  }
  try {
    return await apiFetch<AuthSession>('/auth/get-session');
  } catch {
    return null;
  }
}

// ── Sign-in ────────────────────────────────────────────────────────────────
// BetterAuth's email sign-in returns either a session payload or, when the
// account has TOTP enabled, `{ twoFactorRedirect: true, twoFactorMethods: [...] }`.
// The endpoint sets a temporary 2FA cookie that is later consumed by the
// verify endpoint to issue the real session cookie.
export async function signInEmail(
  email: string,
  password: string,
  oauthQuery?: string,
): Promise<SignInResult> {
  return apiFetch<SignInResult>('/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    }),
  });
}

// ── Password reset (unauthenticated) ───────────────────────────────────────
// `requestPasswordReset` answers the same generic payload whether or not the
// address matches an account, so the caller must never branch on the result:
// doing so would turn the endpoint into an account-enumeration oracle.
export async function requestPasswordReset(
  email: string,
  redirectTo: string,
): Promise<void> {
  if (USE_MOCK) return;
  await apiFetch('/auth/request-password-reset', {
    method: 'POST',
    body: JSON.stringify({ email, redirectTo }),
  });
}

// BetterAuth accepts the reset token either in the body or as a `?token=`
// query parameter of POST /auth/reset-password; the modern body shape is used
// here so the token never has to appear in a URL that gets logged.
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  if (USE_MOCK) return;
  await apiFetch('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

// ── Authenticated password change ──────────────────────────────────────────
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  revokeOtherSessions: boolean,
): Promise<void> {
  if (USE_MOCK) return;
  await apiFetch('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions }),
  });
}

// ── Two-factor authentication (TOTP) ───────────────────────────────────────

export async function enableTwoFactor(password: string): Promise<MfaSetupResult> {
  return apiFetch<MfaSetupResult>('/auth/two-factor/enable', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function disableTwoFactor(password: string): Promise<void> {
  await apiFetch('/auth/two-factor/disable', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function verifyTotp(
  code: string,
  oauthQuery?: string,
): Promise<SignInResult> {
  return apiFetch<SignInResult>('/auth/two-factor/verify-totp', {
    method: 'POST',
    body: JSON.stringify({
      code,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    }),
  });
}

export async function verifyBackupCode(
  code: string,
  oauthQuery?: string,
): Promise<SignInResult> {
  return apiFetch<SignInResult>('/auth/two-factor/verify-backup-code', {
    method: 'POST',
    body: JSON.stringify({
      code,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    }),
  });
}

/**
 * Ask the OP for a fresh `session_state` bound to the current browser session.
 * Needed after an internal OAuth resume, which returns the client redirect
 * without passing through the authorize route that normally appends it.
 */
export async function appendSessionState(
  url: string,
  oauthQuery: string,
): Promise<string> {
  if (USE_MOCK || !oauthQuery) return url;
  const query = new URLSearchParams(oauthQuery);
  const clientId = query.get('client_id');
  const redirectUri = query.get('redirect_uri');
  if (!clientId || !redirectUri) return url;
  try {
    const response = await fetch(
      `/api/session-state?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) return url;
    const body = (await response.json()) as { session_state?: string | null };
    if (!body.session_state) return url;
    const target = new URL(url);
    target.searchParams.set('session_state', body.session_state);
    return target.toString();
  } catch {
    return url;
  }
}

export async function generateBackupCodes(
  password: string,
): Promise<MfaBackupCodesResult> {
  return apiFetch<MfaBackupCodesResult>(
    '/auth/two-factor/generate-backup-codes',
    {
      method: 'POST',
      body: JSON.stringify({ password }),
    },
  );
}
