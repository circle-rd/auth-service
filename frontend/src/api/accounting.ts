import { apiFetch, USE_MOCK } from './client';
import type { JournalPage, JournalQuery } from '@/types/accounting';
import { MOCK_JOURNAL } from '@/mocks/accounting';

function queryString(params: JournalQuery): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  return qs.toString();
}

export async function listJournal(params: JournalQuery): Promise<JournalPage> {
  if (USE_MOCK) {
    const from = params.from ? Date.parse(params.from) : -Infinity;
    const to = params.to ? Date.parse(params.to) : Infinity;
    const matching = MOCK_JOURNAL.filter(
      (e) =>
        (!params.kind || e.kind === params.kind) &&
        (!params.userId || e.owner.id === params.userId) &&
        (!params.applicationId || e.application?.id === params.applicationId) &&
        Date.parse(e.createdAt) >= from &&
        Date.parse(e.createdAt) < to,
    );
    const start = (params.page - 1) * params.limit;
    return { entries: matching.slice(start, start + params.limit), total: matching.length, page: params.page, limit: params.limit };
  }
  return apiFetch<JournalPage>(`/admin/accounting/journal?${queryString(params)}`);
}
