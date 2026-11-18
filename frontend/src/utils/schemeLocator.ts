export interface LocatorSpec {
  placeholder: string;
  // Suffix of `share.resources.locatorHints.<key>`.
  hintKey: 'llm' | 'agent' | 'mcp' | 'https' | 'file' | 'generic';
}

// Display aids only: the server owns the real locator grammar and rejects a malformed one.
const SPECS: Readonly<Record<string, LocatorSpec>> = {
  llm: { placeholder: 'app-slug/model-name', hintKey: 'llm' },
  agent: { placeholder: 'app-slug/agent-name', hintKey: 'agent' },
  mcp: { placeholder: 'app-slug/server-name', hintKey: 'mcp' },
  https: { placeholder: 'host.example.com/path', hintKey: 'https' },
  file: { placeholder: '/path/to/file', hintKey: 'file' },
};

export function locatorSpec(scheme: string): LocatorSpec {
  return SPECS[scheme] ?? { placeholder: 'identifier', hintKey: 'generic' };
}
