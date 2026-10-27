<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import { Clock, Globe, Monitor } from 'lucide-vue-next';
import { getUserLoginHistory } from '@/api/applications';
import { PAGE_SIZE_OPTIONS, usePersistentPageSize } from '@/composables/usePersistentPageSize';
import { parseUserAgent } from '@/composables/useUserAgent';
import type { LoginHistoryEntry } from '@/types';

const props = defineProps<{
  open: boolean;
  appId: string;
  userId: string;
  userName?: string | null;
  /** Bumped by the parent on a live `login.recorded` event to refresh in place. */
  refreshKey?: number;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const loading = ref(false);
const entries = ref<LoginHistoryEntry[]>([]);
const total = ref(0);
const page = ref(1);
const limit = usePersistentPageSize('app-user-history', 20);
const error = ref<string | null>(null);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit.value)));
const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: String(size) }));

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await getUserLoginHistory(props.appId, props.userId, { page: page.value, limit: limit.value });
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

watch(limit, () => {
  page.value = 1;
  if (props.open) void load();
});

// A live login event re-reads the current page without losing the user's place.
watch(() => props.refreshKey, () => {
  if (props.open) void load();
});

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

      <div v-if="!loading && total > 0" class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-surface-500">
        <div class="flex items-center gap-2">
          <label class="text-surface-500">{{ t('dataTable.rowsPerPage') }}</label>
          <BaseSelect
            :model-value="String(limit)"
            :options="pageSizeOptions"
            size="sm"
            class="w-20"
            @update:model-value="(value: string) => (limit = Number(value))"
          />
          <span class="tabular-nums">{{ t('dataTable.pageOf', { from: (page - 1) * limit + 1, to: Math.min(page * limit, total), total }) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <BaseButton variant="outline" size="sm" :disabled="page === 1" @click="page--; load()">{{ t('common.previous') }}</BaseButton>
          <span class="tabular-nums">{{ page }} / {{ pageCount }}</span>
          <BaseButton variant="outline" size="sm" :disabled="page >= pageCount" @click="page++; load()">{{ t('common.next') }}</BaseButton>
        </div>
      </div>
    </div>
  </BaseModal>
</template>
