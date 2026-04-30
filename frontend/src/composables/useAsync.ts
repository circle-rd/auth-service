import { ref } from 'vue';
import type { Ref } from 'vue';
import { ApiError } from '@/api/client';

export interface AsyncState<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<ApiError | null>
  execute: (...args: unknown[]) => Promise<void>
}

export function useAsync<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
): {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<ApiError | null>
  execute: (...args: Args) => Promise<void>
} {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref<ApiError | null>(null);

  async function execute(...args: Args): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      data.value = await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) {
        error.value = err;
      } else {
        error.value = new ApiError('UNKNOWN', err instanceof Error ? err.message : 'An unknown error occurred');
      }
      console.error(err);
    } finally {
      loading.value = false;
    }
  }

  return { data, loading, error, execute };
}
