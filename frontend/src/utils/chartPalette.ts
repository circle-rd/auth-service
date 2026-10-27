/**
 * Chart colours. Each spend dimension keeps its own palette, so a chart of spend
 * by application never shares a hue with the one by kind or by model: the three
 * sets hold distinct hex values.
 */

const APPLICATION_PALETTE = [
  '#0ea5e9', '#22c55e', '#f59e0b', '#a855f7', '#ec4899',
  '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#eab308',
];

const MODEL_PALETTE = [
  '#1d4ed8', '#047857', '#b45309', '#7c3aed', '#be123c',
  '#0f766e', '#c2410c', '#4d7c0f', '#0369a1', '#a16207',
];

const KIND_PALETTE: Record<string, string> = {
  llm: '#6366f1',
  mcp: '#e11d48',
  other: '#64748b',
};

/** Stable index for a label: the same label keeps its colour across renders. */
function hash(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i += 1) h = (h * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick(palette: string[], label: string): string {
  return palette[hash(label) % palette.length]!;
}

export function applicationColor(label: string): string {
  return pick(APPLICATION_PALETTE, label);
}

export function modelColor(label: string): string {
  return pick(MODEL_PALETTE, label);
}

export function kindColor(kind: string): string {
  return KIND_PALETTE[kind] ?? KIND_PALETTE.other!;
}

/** `#rrggbb` with an alpha channel, for a bar fill that hovers to full opacity. */
export function withAlpha(hex: string, alpha: number): string {
  const channel = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${channel}`;
}
