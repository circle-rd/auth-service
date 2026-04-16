import { apiFetch, USE_MOCK } from './client';
import type { ConsumptionAggregate } from '@/types';
import { MOCK_CONSUMPTION } from '@/mocks/data';

export async function getUserConsumption(userId: string, appId: string): Promise<{ aggregates: ConsumptionAggregate[] }> {
  if (USE_MOCK) {
    return { aggregates: MOCK_CONSUMPTION.filter(c => c.userId === userId && c.applicationId === appId) };
  }
  return apiFetch<{ aggregates: ConsumptionAggregate[] }>(`/consumption/${userId}/${appId}`);
}

export async function resetConsumption(userId: string, appId: string, key: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_CONSUMPTION.findIndex(c => c.userId === userId && c.applicationId === appId && c.key === key);
    if (idx >= 0) MOCK_CONSUMPTION.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/consumption/${userId}/${appId}/${key}`, { method: 'DELETE' });
}
