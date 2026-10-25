import { apiFetch, USE_MOCK } from './client';
import { MOCK_APPLICATIONS } from '@/mocks/data';

export interface ActiveUsersResponse {
  count: number;
}

/** One day of a dense daily-count series (`YYYY-MM-DD`, UTC day). */
export interface DailyCountPoint {
  date: string;
  count: number;
}

export type LoginsSeriesPoint = DailyCountPoint;

export interface LoginsResponse {
  range: '7d' | '30d';
  series: LoginsSeriesPoint[];
  total: number;
}

export interface RegistrationsResponse {
  range: '7d' | '30d';
  series: DailyCountPoint[];
  total: number;
}

export interface AppActivityEntry {
  appId: string;
  online: number;
  last7dLogins: number;
  sparkline: number[];
}

export interface ApplicationsActivityResponse {
  applications: AppActivityEntry[];
}

function mockSeries(days: number): LoginsSeriesPoint[] {
  const out: LoginsSeriesPoint[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: 3 + ((i * 5 + 2) % 7) + Math.floor((days - i) / 6) });
  }
  return out;
}

function mockRegistrations(days: number): DailyCountPoint[] {
  const out: DailyCountPoint[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: (i * 3 + 1) % 3 });
  }
  return out;
}

export async function getActiveUsers(): Promise<ActiveUsersResponse> {
  if (USE_MOCK) return { count: 9 };
  return apiFetch<ActiveUsersResponse>('/admin/stats/active-users');
}

export async function getLogins(params: { range?: '7d' | '30d'; appId?: string } = {}): Promise<LoginsResponse> {
  const range = params.range ?? '7d';
  if (USE_MOCK) {
    const series = mockSeries(range === '7d' ? 7 : 30);
    return { range, series, total: series.reduce((a, b) => a + b.count, 0) };
  }
  const qs = new URLSearchParams();
  qs.set('range', range);
  if (params.appId) qs.set('appId', params.appId);
  return apiFetch<LoginsResponse>(`/admin/stats/logins?${qs}`);
}

export async function getRegistrations(params: { range?: '7d' | '30d' } = {}): Promise<RegistrationsResponse> {
  const range = params.range ?? '7d';
  if (USE_MOCK) {
    const series = mockRegistrations(range === '7d' ? 7 : 30);
    return { range, series, total: series.reduce((a, b) => a + b.count, 0) };
  }
  return apiFetch<RegistrationsResponse>(`/admin/stats/registrations?range=${range}`);
}

export async function getApplicationsActivity(): Promise<ApplicationsActivityResponse> {
  if (USE_MOCK) {
    return {
      applications: MOCK_APPLICATIONS.map((a, i) => ({
        appId: a.id,
        online: (i * 3 + 2) % 7,
        last7dLogins: 40 + i * 23,
        sparkline: Array.from({ length: 7 }, (_, d) => 4 + ((d * (i + 3) + i) % 9)),
      })),
    };
  }
  return apiFetch<ApplicationsActivityResponse>('/admin/stats/applications-activity');
}
