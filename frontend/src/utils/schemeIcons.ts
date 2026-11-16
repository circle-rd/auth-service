import type { Component } from 'vue';
import {
  Bot, BrainCircuit, Box, Cloud, Cpu, Database, FileText, Folder, GitBranch, Globe,
  KeyRound, Layers, Package, Plug, Server, Shapes, ShieldCheck, Terminal,
} from '@lucide/vue';

/** Icon names the platform stores for built-in types, also offered for custom ones. */
export const SCHEME_ICON_CHOICES: Readonly<Record<string, Component>> = {
  model: BrainCircuit,
  agent: Bot,
  mcp: Plug,
  terminal: Terminal,
  globe: Globe,
  file: FileText,
  database: Database,
  server: Server,
  cloud: Cloud,
  package: Package,
  folder: Folder,
  git: GitBranch,
  key: KeyRound,
  shield: ShieldCheck,
  cpu: Cpu,
  layers: Layers,
  box: Box,
};

// Fallback when a built-in row carries no icon.
const SCHEME_DEFAULT_ICON: Readonly<Record<string, string>> = {
  llm: 'model',
  agent: 'agent',
  mcp: 'mcp',
  ssh: 'terminal',
  https: 'globe',
  file: 'file',
};

const SCHEME_TONES = [
  'from-blue-600/30 to-blue-800/20 border-blue-700/30 text-blue-300',
  'from-emerald-600/30 to-emerald-800/20 border-emerald-700/30 text-emerald-300',
  'from-amber-600/30 to-amber-800/20 border-amber-700/30 text-amber-300',
  'from-rose-600/30 to-rose-800/20 border-rose-700/30 text-rose-300',
  'from-teal-600/30 to-teal-800/20 border-teal-700/30 text-teal-300',
  'from-sky-600/30 to-sky-800/20 border-sky-700/30 text-sky-300',
  'from-violet-600/30 to-violet-800/20 border-violet-700/30 text-violet-300',
];

const FIXED_TONES: Readonly<Record<string, number>> = {
  llm: 6, agent: 4, mcp: 5, ssh: 1, https: 0, file: 2,
};

export type ResolvedSchemeIcon =
  | { kind: 'component'; component: Component }
  | { kind: 'url'; url: string };

export function isIconUrl(value: string): boolean {
  return /^https:\/\//i.test(value);
}

export function resolveSchemeIcon(icon: string | null | undefined, scheme?: string): ResolvedSchemeIcon {
  const raw = icon?.trim() ?? '';
  if (raw && isIconUrl(raw)) return { kind: 'url', url: raw };
  const name = raw || (scheme ? SCHEME_DEFAULT_ICON[scheme] : undefined) || '';
  return { kind: 'component', component: SCHEME_ICON_CHOICES[name] ?? Shapes };
}

export function schemeTone(scheme: string | undefined): string {
  const key = scheme ?? '';
  const fixed = FIXED_TONES[key];
  if (fixed !== undefined) return SCHEME_TONES[fixed] ?? SCHEME_TONES[0]!;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SCHEME_TONES[hash % SCHEME_TONES.length] ?? SCHEME_TONES[0]!;
}
