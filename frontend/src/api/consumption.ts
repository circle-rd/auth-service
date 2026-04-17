import { apiFetch, USE_MOCK } from './client';
import type { ConsumptionAggregate } from '@/types';
import { MOCK_CONSUMPTION } from '@/mocks/data';

export async function getUserConsumption(userId: string, appId: string): Promise<{ aggregates: ConsumptionAggregate[] }> {
  if (USE_MOCK) {
    return { aggregates: MOCK_CONSUMPTION.filter(c => c.userId === userId && c.applicationId === appId) };
  }
  return apiFetch<{ aggregates: ConsumptionAggregate[] }>(`/consumption/${userId}/${appId}`);
}

export async function getMyConsumption(appId: string): Promise<{ aggregates: ConsumptionAggregate[] }> {
  if (USE_MOCK) {
    return { aggregates: MOCK_CONSUMPTION.filter(c => c.applicationId === appId) };
  }
  return apiFetch<{ aggregates: ConsumptionAggregate[] }>(`/user/consumption/${appId}`);
}

export async function getMonthlyConsumption(appId: string, year?: number, month?: number): Promise<{ entries: Array<{ userId: string; key: string; total: string }> }> {
  if (USE_MOCK) {
    const entries = MOCK_CONSUMPTION
      .filter(c => c.applicationId === appId)
      .map(c => ({ userId: c.userId, key: c.key, total: c.total }));
    return { entries };
  }
  const params = new URLSearchParams();
  if (year !== undefined) params.set('year', String(year));
  if (month !== undefined) params.set('month', String(month));
  const qs = params.toString();
  return apiFetch<{ entries: Array<{ userId: string; key: string; total: string }> }>(
    `/admin/applications/${appId}/consumption/monthly${qs ? `?${qs}` : ''}`
  );
}

export async function resetConsumption(userId: string, appId: string, key: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_CONSUMPTION.findIndex(c => c.userId === userId && c.applicationId === appId && c.key === key);
    if (idx >= 0) MOCK_CONSUMPTION.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/consumption/${userId}/${appId}/${key}`, { method: 'DELETE' });
}
