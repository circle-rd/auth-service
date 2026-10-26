import { ref, watch } from 'vue';

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

const STORAGE_PREFIX = 'auth-service:page-size:';

function readStoredSize(key: string, options: readonly number[], fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return options.includes(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Page size for one listing, persisted per browser. The key must be stable and
 * unique per listing (`users`, `admin-wallets`, `app-users:<id>`, …), so
 * changing one table never changes another one's preference.
 */
export function usePersistentPageSize(
  listing: string,
  fallback: number = 20,
  options: readonly number[] = PAGE_SIZE_OPTIONS,
) {
  const fallbackSize = options.includes(fallback) ? fallback : options[0]!;
  const storageKey = `${STORAGE_PREFIX}${listing}`;
  const pageSize = ref(readStoredSize(storageKey, options, fallbackSize));

  watch(pageSize, (value) => {
    try {
      window.localStorage.setItem(storageKey, String(value));
    } catch {
      // Private browsing or a full quota must not break pagination.
    }
  });

  return pageSize;
}
