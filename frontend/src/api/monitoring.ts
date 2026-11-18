import { apiFetch } from './client';

export type MonitoringRange = '7d' | '30d';

export interface DecisionSeriesPoint {
  date: string;
  allow: number;
  deny: number;
}

export interface SecurityStats {
  range: MonitoringRange;
  generatedAt: string;
  resources: {
    total: number;
    byStatus: { status: string; count: number }[];
    byScheme: { scheme: string; count: number }[];
  };
  grants: {
    active: number;
    expiringSoon: number;
    everyone: number;
    bySubjectType: { subjectType: string; count: number }[];
  };
  invitations: { pending: number };
  access: {
    allow: number;
    deny: number;
    series: DecisionSeriesPoint[];
    bySource: { source: string; allow: number; deny: number }[];
    topDeniedReasons: { reason: string; count: number }[];
    topResources: { uri: string; scheme: string; calls: number; denies: number }[];
    topSubjects: {
      subjectId: string;
      name: string | null;
      email: string | null;
      calls: number;
      denies: number;
    }[];
  };
}

export interface AdminAccessEvent {
  id: string;
  occurredAt: string;
  uri: string;
  scheme: string;
  subjectId: string | null;
  subjectName: string | null;
  subjectEmail: string | null;
  clientId: string;
  applicationId: string | null;
  decision: 'allow' | 'deny';
  reasonClass: string | null;
  source: string;
}

export interface AdminAccessEventPage {
  events: AdminAccessEvent[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface BusinessStats {
  generatedAt: string;
  currency: string;
  mrr: number;
  arr: number;
  payingSubscriptions: number;
  unpricedSubscriptions: number;
  byPlan: {
    planId: string;
    planName: string;
    applicationName: string;
    count: number;
    mrr: number;
  }[];
}

export interface UserActivity {
  range: MonitoringRange;
  shared: {
    allow: number;
    deny: number;
    series: DecisionSeriesPoint[];
    topResources: { uri: string; scheme: string; calls: number }[];
    topSubjects: { subjectId: string; name: string | null; calls: number; lastAt: string }[];
    recent: {
      occurredAt: string;
      uri: string;
      subjectName: string | null;
      decision: 'allow' | 'deny';
      source: string;
    }[];
  };
  used: {
    calls: number;
    series: { date: string; calls: number }[];
    topResources: { uri: string; scheme: string; calls: number }[];
    totalTokens: number;
    costUsd: string;
  };
}

export async function getSecurityStats(range: MonitoringRange): Promise<SecurityStats> {
  return apiFetch(`/admin/monitoring/security?range=${range}`);
}

export async function listAdminAccessEvents(query: {
  decision?: 'allow' | 'deny';
  limit?: number;
  offset?: number;
} = {}): Promise<AdminAccessEventPage> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return apiFetch(`/admin/monitoring/access-events${encoded ? `?${encoded}` : ''}`);
}

export async function getBusinessStats(): Promise<BusinessStats> {
  return apiFetch('/admin/monitoring/business');
}

export async function getUserActivity(applicationId: string, range: MonitoringRange): Promise<UserActivity> {
  return apiFetch(`/user/resource-activity?applicationId=${applicationId}&range=${range}`);
}
