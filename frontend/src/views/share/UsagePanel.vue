<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  getOwnerUsage,
  type OwnerUsage,
  type UsageResourceRow,
  type UsageTotals,
  type UsageUserRow,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { toIso, toLocalInput } from './format';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();

const LIMIT = 50;
const DEFAULT_RANGE_DAYS = 30;

const groupBy = ref<'user' | 'resource'>('user');
const from = ref('');
const to = ref('');
const offset = ref(0);
const usage = ref<OwnerUsage | null>(null);
const loading = ref(true);

const groupOptions = computed<SelectOption[]>(() => [
  { value: 'user', label: t('share.usage.byUser') },
  { value: 'resource', label: t('share.usage.byResource') },
]);

const items = computed<Array<UsageUserRow | UsageResourceRow>>(() => usage.value?.items ?? []);
const totals = computed<UsageTotals | null>(() => (items.value.length > 0 ? usage.value?.totals ?? null : null));
const hasPrev = computed(() => offset.value > 0);
const hasNext = computed(() => usage.value?.hasMore === true);

function setDefaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  from.value = toLocalInput(start.toISOString());
  to.value = toLocalInput(end.toISOString());
}

function isUserRow(row: UsageUserRow | UsageResourceRow): row is UsageUserRow {
  return 'subjectId' in row;
}

function rowLabel(row: UsageUserRow | UsageResourceRow): string {
  if (isUserRow(row)) return row.subjectId;
  return row.displayName ?? row.resourceKey;
}

function rowDetail(row: UsageUserRow | UsageResourceRow): string | null {
  return isUserRow(row) ? null : row.resourceKey;
}

function telemetryAvailable(row: UsageTotals): boolean {
  return row.calls === 0 || row.unsupportedCalls < row.calls;
}

function telemetryPartial(row: UsageTotals): boolean {
  return row.unsupportedCalls > 0 && row.unsupportedCalls < row.calls;
}

function costLabel(row: UsageTotals): string {
  return telemetryAvailable(row) ? row.costUsd : t('share.usage.notAvailable');
}

function numberLabel(row: UsageTotals, value: number | null | undefined, field: 'totalTokens' | 'promptTokens' | 'completionTokens'): string {
  if (!telemetryAvailable(row) || value === null || value === undefined) return t('share.usage.notAvailable');
  if (field === 'totalTokens') return String(value);
  return String(value);
}

async function load() {
  const fromIso = toIso(from.value);
  const toIsoValue = toIso(to.value);
  if (!fromIso || !toIsoValue) return;
  loading.value = true;
  try {
    usage.value = await getOwnerUsage(props.appId, {
      groupBy: groupBy.value,
      from: fromIso,
      to: toIsoValue,
      limit: LIMIT,
      offset: offset.value,
    });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function resetOffsetAndLoad() {
  offset.value = 0;
  void load();
}

watch([groupBy, from, to], resetOffsetAndLoad);
watch(offset, () => void load());
watch(() => props.appId, resetOffsetAndLoad);

setDefaultRange();
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-surface-400">{{ t('share.usage.hint') }}</p>

    <div class="flex flex-wrap items-end gap-3">
      <BaseSelect v-model="groupBy" :label="t('share.usage.groupBy')" :options="groupOptions" class="w-48" />
      <BaseInput v-model="from" type="datetime-local" :label="t('share.usage.from')" class="w-56" />
      <BaseInput v-model="to" type="datetime-local" :label="t('share.usage.to')" class="w-56" />
    </div>

    <div v-if="totals" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="rounded-xl border border-surface-700/40 bg-surface-900/40 px-4 py-3">
        <p class="text-xs text-surface-500 uppercase tracking-wide">{{ t('share.usage.calls') }}</p>
        <p class="text-lg font-semibold text-surface-200">{{ totals.calls }}</p>
      </div>
      <div class="rounded-xl border border-surface-700/40 bg-surface-900/40 px-4 py-3">
        <p class="text-xs text-surface-500 uppercase tracking-wide">{{ t('share.usage.tokens') }}</p>
        <p class="text-lg font-semibold text-surface-200">
          {{ numberLabel(totals, totals.totalTokens, 'totalTokens') }}
        </p>
      </div>
      <div class="rounded-xl border border-surface-700/40 bg-surface-900/40 px-4 py-3">
        <p class="text-xs text-surface-500 uppercase tracking-wide">{{ t('share.usage.cost') }}</p>
        <p class="text-lg font-semibold text-surface-200">{{ costLabel(totals) }}</p>
      </div>
      <div class="rounded-xl border border-surface-700/40 bg-surface-900/40 px-4 py-3">
        <p class="text-xs text-surface-500 uppercase tracking-wide">{{ t('share.usage.unsupported') }}</p>
        <p class="text-lg font-semibold text-surface-200">{{ totals.unsupportedCalls }}</p>
      </div>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="items.length === 0"
      :title="t('share.usage.empty')"
      :message="t('share.usage.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">
              {{ groupBy === 'user' ? t('share.usage.subject') : t('share.usage.resource') }}
            </th>
            <th class="text-right font-medium px-4 py-3">{{ t('share.usage.calls') }}</th>
            <th class="text-right font-medium px-4 py-3 hidden md:table-cell">{{ t('share.usage.promptTokens') }}</th>
            <th class="text-right font-medium px-4 py-3 hidden md:table-cell">{{ t('share.usage.completionTokens') }}</th>
            <th class="text-right font-medium px-4 py-3">{{ t('share.usage.tokens') }}</th>
            <th class="text-right font-medium px-4 py-3">{{ t('share.usage.cost') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in items" :key="isUserRow(row) ? row.subjectId : row.resourceId" class="border-t border-surface-800/60">
            <td class="px-4 py-3">
              <p class="font-medium text-surface-200">{{ rowLabel(row) }}</p>
              <p v-if="rowDetail(row)" class="font-mono text-xs text-surface-500">{{ rowDetail(row) }}</p>
              <p v-if="!isUserRow(row)" class="text-xs text-surface-500">
                {{ t(`share.resourceTypes.${row.resourceType}`) }}
              </p>
            </td>
            <td class="px-4 py-3 text-right text-surface-300">{{ row.calls }}</td>
            <td class="px-4 py-3 text-right text-surface-400 hidden md:table-cell">
              {{ numberLabel(row, row.promptTokens, 'promptTokens') }}
            </td>
            <td class="px-4 py-3 text-right text-surface-400 hidden md:table-cell">
              {{ numberLabel(row, row.completionTokens, 'completionTokens') }}
            </td>
            <td class="px-4 py-3 text-right text-surface-300">
              {{ numberLabel(row, row.totalTokens, 'totalTokens') }}
            </td>
            <td class="px-4 py-3 text-right text-surface-300">{{ costLabel(row) }}</td>
            <td class="px-4 py-3">
              <BaseBadge v-if="!telemetryAvailable(row)" variant="neutral">
                {{ t('share.usage.notAvailable') }}
              </BaseBadge>
              <BaseBadge v-else-if="telemetryPartial(row)" variant="warning">
                {{ t('share.usage.partial', { count: row.unsupportedCalls }) }}
              </BaseBadge>
              <BaseBadge v-else variant="success" dot>{{ t('share.usage.reported') }}</BaseBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="items.length > 0" class="flex items-center justify-between gap-3">
      <p class="text-xs text-surface-500">
        {{ t('share.usage.range', { from: offset + 1, to: offset + items.length }) }}
      </p>
      <div class="flex gap-2">
        <BaseButton variant="outline" size="sm" :disabled="!hasPrev" @click="offset -= LIMIT">
          <ChevronLeft class="w-3.5 h-3.5" />{{ t('common.previous') }}
        </BaseButton>
        <BaseButton variant="outline" size="sm" :disabled="!hasNext" @click="offset += LIMIT">
          {{ t('common.next') }}<ChevronRight class="w-3.5 h-3.5" />
        </BaseButton>
      </div>
    </div>
  </div>
</template>
