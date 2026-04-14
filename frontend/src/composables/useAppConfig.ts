import { ref, watch } from "vue";
import type { Ref } from "vue";

export interface AppConfig {
  allowRegister: boolean;
  enabledSocialProviders: string[];
}

// Fail-open default used when the endpoint is unreachable.
const FALLBACK: AppConfig = { allowRegister: true, enabledSocialProviders: [] };

export function useAppConfig(clientId: Ref<string | undefined>): {
  appConfig: Ref<AppConfig | null>;
  loadingConfig: Ref<boolean>;
} {
  const appConfig = ref<AppConfig | null>(null);
  const loadingConfig = ref(true);

  async function load(id: string | undefined): Promise<void> {
    loadingConfig.value = true;
    try {
      const url = id
        ? `/api/app-config?client_id=${encodeURIComponent(id)}`
        : "/api/app-config";
      const res = await fetch(url);
      appConfig.value = res.ok ? ((await res.json()) as AppConfig) : FALLBACK;
    } catch {
      appConfig.value = FALLBACK;
    } finally {
      loadingConfig.value = false;
    }
  }

  watch(clientId, (id) => { void load(id); }, { immediate: true });

  return { appConfig, loadingConfig };
}
