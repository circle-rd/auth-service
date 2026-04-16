import { apiFetch, USE_MOCK } from './client';
import type { Session } from '@/types';
import { MOCK_SESSIONS } from '@/mocks/data';

export interface SessionsListResponse {
  sessions: Session[]
  total: number
  page: number
  limit: number
}

export async function listSessions(params: { page?: number; limit?: number } = {}): Promise<SessionsListResponse> {
  if (USE_MOCK) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const start = (page - 1) * limit;
    return { sessions: MOCK_SESSIONS.slice(start, start + limit), total: MOCK_SESSIONS.length, page, limit };
  }
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  return apiFetch<SessionsListResponse>(`/admin/sessions?${qs}`);
}

export async function revokeSession(id: string): Promise<void> {
  console.log('TODO: Revoke session', id);
}
