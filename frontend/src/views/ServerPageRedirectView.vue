<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// These paths are always server-rendered (invitation pages have no SPA
// equivalent). A client-side navigation must therefore perform a full page
// load so the request reaches the Fastify route instead of the SPA's
// not-found view. The short guard prevents an endless reload if a proxy or a
// stale deployment serves the SPA for this path.
const RETRY_WINDOW_MS = 5000;
const { t } = useI18n();
const blocked = ref(false);

function storageKey(): string {
  return `server-page-reload:${window.location.pathname}${window.location.search}`;
}

onMounted(() => {
  const url = new URL(window.location.href);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    window.location.replace(url.toString());
    return;
  }

  try {
    const key = storageKey();
    const lastAttempt = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - lastAttempt < RETRY_WINDOW_MS) {
      blocked.value = true;
      return;
    }
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // Without storage the guard cannot survive a reload; fall through once.
  }
  window.location.reload();
});

function retry() {
  try {
    sessionStorage.removeItem(storageKey());
  } catch {
    // Ignore storage failures and let the reload decide.
  }
  window.location.reload();
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-surface-950 p-6">
    <div v-if="blocked" class="max-w-md space-y-3 text-center">
      <p class="text-sm font-medium text-surface-100">{{ t('common.serverPageUnavailable') }}</p>
      <p class="text-xs text-surface-500">{{ t('common.serverPageUnavailableHint') }}</p>
      <button
        type="button"
        class="rounded-lg border border-surface-700 px-3 py-1.5 text-xs font-medium text-surface-200 hover:border-surface-500"
        @click="retry"
      >
        {{ t('common.retry') }}
      </button>
    </div>
    <div v-else aria-busy="true" />
  </div>
</template>
