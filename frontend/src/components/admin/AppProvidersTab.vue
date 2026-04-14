<script setup lang="ts">
  import { ref, onMounted } from "vue";
  import { useI18n } from "vue-i18n";

  const props = defineProps<{
    appId: string;
    appSlug: string;
  }>();

  const { t } = useI18n();

  type SocialProvider = "google" | "github" | "linkedin" | "microsoft" | "apple";
  const ALL_PROVIDERS: SocialProvider[] = ["google", "github", "linkedin", "microsoft", "apple"];

  // Providers enabled globally in the environment (.env)
  const globalProviders = ref<SocialProvider[]>([]);
  // Providers enabled for this specific app (null = inherit all)
  const appProviders = ref<SocialProvider[] | null>(null);
  // Local copy for the form checkboxes
  const selected = ref<Set<SocialProvider>>(new Set());

  const loading = ref(true);
  const saving = ref(false);
  const saveError = ref<string | null>(null);
  const saveSuccess = ref(false);

  async function fetchData() {
    loading.value = true;
    try {
      // Fetch global providers (no client_id → returns all globally enabled)
      const configRes = await fetch("/api/app-config", { credentials: "include" });
      const configData = (await configRes.json()) as { enabledSocialProviders: string[] };
      globalProviders.value = (configData.enabledSocialProviders ?? []) as SocialProvider[];

      // Fetch current app's provider setting
      const appRes = await fetch(`/api/admin/applications/${props.appId}`, {
        credentials: "include",
      });
      const appData = (await appRes.json()) as {
        application: { enabledSocialProviders: SocialProvider[] | null };
      };
      appProviders.value = appData.application.enabledSocialProviders;

      // Initialise checkboxes: null = all global providers, otherwise the specific set
      if (appProviders.value === null) {
        selected.value = new Set(globalProviders.value);
      } else {
        selected.value = new Set(appProviders.value.filter((p) => globalProviders.value.includes(p)));
      }
    } finally {
      loading.value = false;
    }
  }

  function toggle(provider: SocialProvider) {
    if (selected.value.has(provider)) {
      selected.value.delete(provider);
    } else {
      selected.value.add(provider);
    }
    // Force reactivity
    selected.value = new Set(selected.value);
  }

  async function save() {
    saving.value = true;
    saveError.value = null;
    saveSuccess.value = false;
    try {
      // Use null (inherit all) when the selection equals the full global set,
      // otherwise store the explicit subset.
      const allGlobalSelected =
        globalProviders.value.length > 0 &&
        globalProviders.value.every((p) => selected.value.has(p)) &&
        selected.value.size === globalProviders.value.length;

      const payload: { enabledSocialProviders: SocialProvider[] | null } = {
        enabledSocialProviders: allGlobalSelected ? null : [...selected.value],
      };

      const res = await fetch(`/api/admin/applications/${props.appId}/providers`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        throw new Error(err.message ?? "Failed to save");
      }

      appProviders.value = payload.enabledSocialProviders;
      saveSuccess.value = true;
      setTimeout(() => (saveSuccess.value = false), 3000);
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : String(err);
    } finally {
      saving.value = false;
    }
  }

  onMounted(() => void fetchData());
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold gradient-text mb-1">{{ t("admin.providers") }}</h1>
    <p class="text-sm mb-6" style="color: var(--color-text-muted)">{{ t("admin.socialProvidersHint") }}</p>

    <div v-if="loading" class="text-sm" style="color: var(--color-text-muted)">{{ t("common.loading") }}</div>

    <template v-else>
      <div v-if="globalProviders.length === 0" class="text-sm" style="color: var(--color-text-muted)">
        {{ t("admin.noProvidersConfigured") }}
      </div>

      <div v-else class="space-y-3 mb-6">
        <label
          v-for="provider in ALL_PROVIDERS"
          :key="provider"
          class="flex items-center gap-3 p-3 rounded-lg cursor-pointer select-none transition-colors"
          :class="{ 'opacity-50 cursor-not-allowed': !globalProviders.includes(provider) }"
          style="border: 1px solid var(--color-border)"
        >
          <input
            type="checkbox"
            :checked="selected.has(provider)"
            :disabled="!globalProviders.includes(provider)"
            class="accent-[var(--color-primary)]"
            @change="toggle(provider)"
          />
          <span class="capitalize font-medium flex-1">{{ provider }}</span>
          <span
            v-if="!globalProviders.includes(provider)"
            class="text-xs"
            style="color: var(--color-text-muted)"
          >
            {{ t("admin.notConfiguredInEnv") }}
          </span>
        </label>
      </div>

      <p v-if="saveError" class="text-sm mb-3" style="color: var(--color-error)">{{ saveError }}</p>
      <p v-if="saveSuccess" class="text-sm mb-3" style="color: var(--color-success)">{{ t("common.done") }}</p>

      <button
        class="btn btn-primary"
        :disabled="saving || globalProviders.length === 0"
        @click="save"
      >
        {{ saving ? t("common.saving") : t("admin.saveProviders") }}
      </button>
    </template>
  </div>
</template>
