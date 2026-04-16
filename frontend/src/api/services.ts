import { apiFetch, USE_MOCK } from './client';
import type { ServicesConfig } from '@/types';
import { MOCK_SERVICES_CONFIG } from '@/mocks/data';

export async function getServicesConfig(): Promise<ServicesConfig> {
  if (USE_MOCK) return MOCK_SERVICES_CONFIG;
  return apiFetch<ServicesConfig>('/admin/services');
}
