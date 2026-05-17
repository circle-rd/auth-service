import { apiFetch, USE_MOCK } from './client';

export interface ActiveUsersResponse {
  count: number;
}

export interface LoginsSeriesPoint {
  date: string;
  count: number;
}

export interface LoginsResponse {
  range: '7d' | '30d';
  series: LoginsSeriesPoint[];
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
    out.push({ date, count: Math.floor(Math.random() * 8) });
  }
  return out;
}

export async function getActiveUsers(): Promise<ActiveUsersResponse> {
  if (USE_MOCK) return { count: Math.floor(Math.random() * 12) };
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

export async function getApplicationsActivity(): Promise<ApplicationsActivityResponse> {
  if (USE_MOCK) {
    return {
      applications: [],
    };
  }
  return apiFetch<ApplicationsActivityResponse>('/admin/stats/applications-activity');
}
