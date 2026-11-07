export type StatsRange = "7d" | "30d";

export function rangeToDays(range: StatsRange): number {
  return range === "30d" ? 30 : 7;
}

/**
 * Build a dense [{ date, value }] series for the given range, filling missing
 * days with the supplied zero value so consumers never interpolate gaps.
 */
export function denseDailySeries<T>(
  raw: { day: string; value: T }[],
  days: number,
  zero: T,
  anchor: Date = new Date(),
): { date: string; value: T }[] {
  const byDay = new Map(raw.map((r) => [r.day, r.value]));
  const out: { date: string; value: T }[] = [];
  const today = new Date(anchor);
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDay.get(key) ?? zero });
  }
  return out;
}

/** First instant of the range window, in UTC, `days` inclusive of today. */
export function rangeStart(days: number, now: Date = new Date()): Date {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  return since;
}
