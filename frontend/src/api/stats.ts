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

export interface BillingStats {
  range: '7d' | '30d';
  generatedAt: string;
  currency: string;
  revenue: {
    total: number;
    count: number;
    series: { date: string; amount: number }[];
    byCurrency: { currency: string; amount: number }[];
  };
  subscriptions: {
    active: number;
    stripeManaged: number;
    cancelAtPeriodEnd: number;
    byPlan: {
      planId: string;
      planName: string;
      applicationName: string;
      count: number;
    }[];
  };
  customers: { withStripe: number; users: number };
  invoices: { openCount: number; openAmount: number };
  catalog: {
    plans: number;
    plansLinked: number;
    prices: number;
    pricesLinked: number;
    metersLinked: number;
  };
  webhooks: {
    last24h: number;
    last7d: number;
    lastProcessedAt: string | null;
  };
}

function mockBillingStats(range: '7d' | '30d'): BillingStats {
  const days = range === '7d' ? 7 : 30;
  const series: { date: string; amount: number }[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    series.push({ date: d.toISOString().slice(0, 10), amount: 1200 + ((i * 370) % 2400) });
  }
  return {
    range,
    generatedAt: new Date().toISOString(),
    currency: 'eur',
    revenue: {
      total: series.reduce((acc, p) => acc + p.amount, 0),
      count: 18,
      series,
      byCurrency: [{ currency: 'eur', amount: series.reduce((acc, p) => acc + p.amount, 0) }],
    },
    subscriptions: {
      active: 24,
      stripeManaged: 17,
      cancelAtPeriodEnd: 3,
      byPlan: [
        { planId: 'plan-1', planName: 'Premium', applicationName: 'Circle Dashboard', count: 12 },
        { planId: 'plan-2', planName: 'Standard', applicationName: 'Circle Dashboard', count: 7 },
        { planId: 'plan-3', planName: 'Basic', applicationName: 'Internal API', count: 5 },
      ],
    },
    customers: { withStripe: 19, users: 42 },
    invoices: { openCount: 4, openAmount: 8900 },
    catalog: { plans: 5, plansLinked: 4, prices: 9, pricesLinked: 8, metersLinked: 2 },
    webhooks: {
      last24h: 6,
      last7d: 31,
      lastProcessedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
  };
}

export async function getBillingStats(params: { range?: '7d' | '30d' } = {}): Promise<BillingStats> {
  const range = params.range ?? '30d';
  if (USE_MOCK) return mockBillingStats(range);
  return apiFetch<BillingStats>(`/admin/stats/billing?range=${range}`);
}
