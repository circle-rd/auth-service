import { apiFetch, USE_MOCK } from './client';
import type { User, Session } from '@/types';
import { MOCK_CURRENT_USER, MOCK_SESSIONS } from '@/mocks/data';

export interface AuthSession {
  user: User
  session: Session
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
