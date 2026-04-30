import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ServicesConfig } from '@/types';
import { getServicesConfig } from '@/api/services';

export const useServicesStore = defineStore('services', () => {
  const config = ref<ServicesConfig | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      config.value = await getServicesConfig();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load services config';
    } finally {
      loading.value = false;
    }
  }

  return { config, loading, error, fetch };
});
