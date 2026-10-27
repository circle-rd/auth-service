import { ref, type Ref } from 'vue';
import type {
  UserSpendStats,
  WalletAccount,
  WalletTransaction,
  WalletTransactionPage,
} from '@/types/wallet';

export interface WalletDataSource {
  getAccount: () => Promise<WalletAccount>;
  getStats: (days: number) => Promise<UserSpendStats>;
  /** Optional: the raw ledger, loaded on demand (administrator views only). */
  getPage?: (params: { cursor?: string; limit?: number }) => Promise<WalletTransactionPage>;
}

/**
 * Balance, spend statistics and (on demand) cursor-paginated ledger of one
 * wallet. The ledger is not fetched by `refresh`: the wallet views show the
 * daily consumption by default, and the raw movements only when asked for.
 */
export function useWalletData(
  source: WalletDataSource,
  days = 30,
  pageSize?: Ref<number>,
) {
  const account = ref<WalletAccount | null>(null);
  const stats = ref<UserSpendStats | null>(null);
  const items = ref<WalletTransaction[]>([]);
  const nextCursor = ref<string | null>(null);
  const loading = ref(false);
  const ledgerLoading = ref(false);
  const loadingMore = ref(false);
  const error = ref<Error | null>(null);

  // Only the latest refresh may write: an older, slower response must not overwrite it.
  let generation = 0;

  async function refresh(): Promise<void> {
    const current = ++generation;
    loading.value = account.value === null;
    try {
      const [acc, st] = await Promise.all([source.getAccount(), source.getStats(days)]);
      if (current !== generation) return;
      account.value = acc;
      stats.value = st;
      error.value = null;
    } catch (err) {
      if (current !== generation) return;
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  /** Load the first page of the raw ledger; called when its view is opened. */
  async function loadLedger(): Promise<void> {
    if (!source.getPage || ledgerLoading.value) return;
    const current = generation;
    ledgerLoading.value = true;
    try {
      const page = await source.getPage({ limit: pageSize?.value });
      if (current !== generation) return;
      items.value = page.items;
      nextCursor.value = page.nextCursor;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      ledgerLoading.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!source.getPage || nextCursor.value === null || loadingMore.value) return;
    const current = generation;
    loadingMore.value = true;
    try {
      const page = await source.getPage({
        cursor: nextCursor.value,
        limit: pageSize?.value,
      });
      if (current !== generation) return;
      items.value = [...items.value, ...page.items];
      nextCursor.value = page.nextCursor;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loadingMore.value = false;
    }
  }

  return {
    account,
    stats,
    items,
    nextCursor,
    loading,
    ledgerLoading,
    loadingMore,
    error,
    refresh,
    loadLedger,
    loadMore,
  };
}
