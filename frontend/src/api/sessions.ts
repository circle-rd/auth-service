import { apiFetch, USE_MOCK } from './client';
import type { Session } from '@/types';
import { MOCK_SESSIONS } from '@/mocks/data';

export interface SessionsListResponse {
  sessions: Session[]
  total: number
  page: number
  limit: number
}

export async function listSessions(params: { page?: number; limit?: number; search?: string } = {}): Promise<SessionsListResponse> {
  if (USE_MOCK) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const search = params.search?.trim().toLowerCase() ?? '';
    let pool = MOCK_SESSIONS;
    if (search) {
      pool = pool.filter(s =>
        (s.user?.name ?? '').toLowerCase().includes(search)
        || (s.user?.email ?? '').toLowerCase().includes(search)
        || (s.ipAddress ?? '').toLowerCase().includes(search),
      );
    }
    const start = (page - 1) * limit;
    return { sessions: pool.slice(start, start + limit), total: pool.length, page, limit };
  }
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  return apiFetch<SessionsListResponse>(`/admin/sessions?${qs}`);
}

export interface MySessionsResponse {
  sessions: Session[]
  currentSessionId: string
}

export async function listMySessions(): Promise<MySessionsResponse> {
  if (USE_MOCK) {
    return { sessions: MOCK_SESSIONS, currentSessionId: MOCK_SESSIONS[0]?.id ?? '' };
  }
  return apiFetch<MySessionsResponse>('/user/sessions');
}

export async function revokeSession(id: string): Promise<void> {
  if (USE_MOCK) return;
  return apiFetch<void>(`/user/sessions/${id}`, { method: 'DELETE' });
}
