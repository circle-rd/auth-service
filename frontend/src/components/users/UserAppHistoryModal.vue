<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { Clock, Globe, Monitor } from 'lucide-vue-next';
import { getUserLoginHistory } from '@/api/applications';
import { parseUserAgent } from '@/composables/useUserAgent';
import type { LoginHistoryEntry } from '@/types';

const props = defineProps<{
  open: boolean;
  appId: string;
  userId: string;
  userName?: string | null;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const loading = ref(false);
const entries = ref<LoginHistoryEntry[]>([]);
const total = ref(0);
const page = ref(1);
const limit = 20;
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await getUserLoginHistory(props.appId, props.userId, { page: page.value, limit });
    entries.value = res.entries;
    total.value = res.total;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load login history';
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.userId, props.appId], ([isOpen]) => {
  if (isOpen) {
    page.value = 1;
    void load();
  }
}, { immediate: true });

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
  <BaseModal :open="open" :title="userName ? `${t('users.history.title')} — ${userName}` : t('users.history.title')" size="lg" @close="emit('close')">
    <div class="space-y-3">
      <p class="text-xs text-surface-500">{{ t('users.history.description') }}</p>

      <div v-if="loading" class="space-y-2">
        <div v-for="i in 3" :key="i" class="h-12 rounded-lg bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer" />
      </div>

      <p v-else-if="error" class="text-sm text-red-400">{{ error }}</p>

      <div v-else-if="entries.length === 0" class="py-8 text-center text-sm text-surface-500">
        {{ t('users.history.empty') }}
      </div>

      <div v-else class="rounded-xl border border-surface-700/50 overflow-hidden divide-y divide-surface-800/40">
        <div v-for="e in entries" :key="e.id" class="px-4 py-3 flex items-start gap-3 hover:bg-surface-800/20 transition-colors">
          <div class="shrink-0 w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
            <Clock class="w-4 h-4 text-primary-400" />
          </div>
          <div class="flex-1 min-w-0 text-sm">
            <p class="text-surface-200 font-medium">{{ formatDate(e.loggedAt) }}</p>
            <p class="text-xs text-surface-500 mt-0.5 flex flex-wrap items-center gap-3">
              <span v-if="e.ipAddress" class="inline-flex items-center gap-1"><Globe class="w-3 h-3" />{{ e.ipAddress }}</span>
              <span v-if="e.userAgent" class="inline-flex items-center gap-1 truncate"><Monitor class="w-3 h-3" />
                {{ parseUserAgent(e.userAgent).browser }} / {{ parseUserAgent(e.userAgent).os }}
              </span>
            </p>
          </div>
        </div>
      </div>

      <div v-if="!loading && total > limit" class="flex items-center justify-between text-xs text-surface-500">
        <span>{{ t('common.showing', { from: (page - 1) * limit + 1, to: Math.min(page * limit, total), total }) }}</span>
        <div class="flex gap-2">
          <BaseButton variant="outline" size="sm" :disabled="page === 1" @click="page--; load()">{{ t('common.previous') }}</BaseButton>
          <BaseButton variant="outline" size="sm" :disabled="page * limit >= total" @click="page++; load()">{{ t('common.next') }}</BaseButton>
        </div>
      </div>
    </div>
  </BaseModal>
</template>
