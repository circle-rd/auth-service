import { ref } from 'vue';
import type {
  UserSpendStats,
  WalletAccount,
  WalletTransaction,
  WalletTransactionPage,
} from '@/types/wallet';

export interface WalletDataSource {
  getAccount: () => Promise<WalletAccount>;
  getStats: (days: number) => Promise<UserSpendStats>;
  getPage: (params: { cursor?: string }) => Promise<WalletTransactionPage>;
}

/** Balance, spend statistics and cursor-paginated history of one wallet. */
export function useWalletData(source: WalletDataSource, days = 30) {
  const account = ref<WalletAccount | null>(null);
  const stats = ref<UserSpendStats | null>(null);
  const items = ref<WalletTransaction[]>([]);
  const nextCursor = ref<string | null>(null);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref<Error | null>(null);

  // Only the latest refresh may write: an older, slower response must not overwrite it.
  let generation = 0;

  async function refresh(): Promise<void> {
    const current = ++generation;
    loading.value = account.value === null;
    try {
      const [acc, st, page] = await Promise.all([
        source.getAccount(),
        source.getStats(days),
        source.getPage({}),
      ]);
      if (current !== generation) return;
      account.value = acc;
      stats.value = st;
      items.value = page.items;
      nextCursor.value = page.nextCursor;
      error.value = null;
    } catch (err) {
      if (current !== generation) return;
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (current === generation) loading.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (nextCursor.value === null || loadingMore.value) return;
    const current = generation;
    loadingMore.value = true;
    try {
      const page = await source.getPage({ cursor: nextCursor.value });
      if (current !== generation) return;
      items.value = [...items.value, ...page.items];
      nextCursor.value = page.nextCursor;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loadingMore.value = false;
    }
  }

  return { account, stats, items, nextCursor, loading, loadingMore, error, refresh, loadMore };
}
