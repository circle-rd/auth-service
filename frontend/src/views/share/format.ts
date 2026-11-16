export function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function toIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function toLocalInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function statusVariant(state: string): 'success' | 'warning' | 'neutral' | 'error' {
  if (state === 'pending') return 'warning';
  if (state === 'consumed') return 'success';
  if (state === 'revoked' || state === 'expired') return 'neutral';
  return 'error';
}
