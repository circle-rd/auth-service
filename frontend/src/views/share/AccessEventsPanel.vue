<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  listAccessEvents,
  RESOURCE_EVENT_DECISIONS,
  type AccessEvent,
  type ResourceEventDecision,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime } from './format';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();

const LIMIT = 100;

const events = ref<AccessEvent[]>([]);
const loading = ref(true);
const decision = ref<ResourceEventDecision | ''>('');
const offset = ref(0);
const loadedOffset = ref(0);
let latestRequest = 0;

const decisionOptions: SelectOption[] = [
  { value: '', label: t('share.access.all') },
  ...RESOURCE_EVENT_DECISIONS.map((value) => ({
    value,
    label: t(`share.access.decisions.${value}`),
  })),
];

async function load() {
  const request = ++latestRequest;
  loading.value = true;
  try {
    const res = await listAccessEvents(props.appId, {
      decision: decision.value || undefined,
      limit: LIMIT,
      offset: offset.value,
    });
    if (request !== latestRequest) return;
    events.value = res.events;
    loadedOffset.value = offset.value;
  } catch (err) {
    if (request !== latestRequest) return;
    events.value = [];
    loadedOffset.value = 0;
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    if (request === latestRequest) loading.value = false;
  }
}

const hasNext = computed(() => events.value.length === LIMIT);

watch(decision, () => {
  offset.value = 0;
  void load();
});
watch(() => props.appId, () => {
  offset.value = 0;
  void load();
});
watch(offset, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <p class="text-sm text-surface-400">{{ t('share.access.hint') }}</p>
      <BaseSelect v-model="decision" :label="t('share.access.decision')" :options="decisionOptions" class="w-48" />
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="events.length === 0"
      :title="t('share.access.empty')"
      :message="t('share.access.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.access.time') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.access.resource') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.access.subject') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden md:table-cell">{{ t('share.access.client') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.access.decision') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.access.reason') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="event in events" :key="event.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3 text-xs text-surface-400">{{ formatDateTime(event.occurredAt) }}</td>
            <td class="px-4 py-3">
              <p class="font-mono text-xs text-surface-300 break-all">{{ event.uri }}</p>
              <p class="text-[11px] text-surface-500">{{ event.scheme }} · {{ event.source }}</p>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-surface-300 break-all">
              {{ event.subjectId ?? '—' }}
            </td>
            <td class="px-4 py-3 text-xs text-surface-400 hidden md:table-cell">{{ event.clientId }}</td>
            <td class="px-4 py-3">
              <BaseBadge :variant="event.decision === 'allow' ? 'success' : 'warning'" dot>
                {{ t(`share.access.decisions.${event.decision}`) }}
              </BaseBadge>
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden lg:table-cell">
              {{ event.reasonClass ?? '—' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="loadedOffset > 0 || hasNext" class="flex justify-end gap-2">
      <BaseButton variant="outline" size="sm" :disabled="loadedOffset === 0" @click="offset = loadedOffset - LIMIT">
        <ChevronLeft class="w-3.5 h-3.5" />{{ t('common.previous') }}
      </BaseButton>
      <BaseButton variant="outline" size="sm" :disabled="!hasNext" @click="offset = loadedOffset + LIMIT">
        {{ t('common.next') }}<ChevronRight class="w-3.5 h-3.5" />
      </BaseButton>
    </div>
  </div>
</template>
