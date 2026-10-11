import type { WalletTransaction, WalletTransactionType } from '@/types/wallet';

type Translate = (key: string, params?: Record<string, unknown>) => string;

export type TransactionVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary';

export function typeVariant(type: WalletTransactionType): TransactionVariant {
  switch (type) {
    case 'topup': return 'success';
    case 'grant': return 'primary';
    case 'refund': return 'info';
    case 'usage': return 'neutral';
    case 'adjust': return 'warning';
    case 'reversal': return 'error';
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** One readable line describing what a ledger row is about. */
export function describeTransaction(tx: WalletTransaction, t: Translate): string {
  const m = tx.metadata;
  if (tx.type === 'usage') {
    if (m.kind === 'mcp') {
      const server = text(m.mcpServer);
      const tool = text(m.tool);
      return [server, tool ? t('wallet.history.tool', { tool }) : null].filter(Boolean).join(' · ');
    }
    const model = text(m.model);
    const tokens = typeof m.totalTokens === 'number' && m.totalTokens > 0 ? `${m.totalTokens} tokens` : null;
    return [model, tokens].filter(Boolean).join(' · ');
  }
  const reference = text(m.reference);
  if (reference) return t('wallet.history.invoice', { reference });
  const reason = text(m.reason);
  if (m.source === 'stripe') return ['Stripe', reason].filter(Boolean).join(' · ');
  return reason ?? '';
}

export function applicationOf(tx: WalletTransaction): string | null {
  return text(tx.metadata.applicationSlug);
}
