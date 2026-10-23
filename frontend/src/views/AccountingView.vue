<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { AppWindow, ArrowRight, Layers, RefreshCw } from 'lucide-vue-next';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import DataTable from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SearchSelect from '@/components/ui/SearchSelect.vue';
import { listJournal } from '@/api/accounting';
import { listUsers } from '@/api/users';
import { useAdminEvents } from '@/composables/useAdminEvents';
import { useMoney } from '@/composables/useMoney';
import { useToast } from '@/composables/useToast';
import { useApplicationsStore } from '@/stores/applications';
import { JOURNAL_KIND_META, isPlanKind } from '@/utils/journalKinds';
import { JOURNAL_KINDS } from '@/types/accounting';
import type { JournalEntry, JournalKind, JournalPerson, JournalQuery } from '@/types/accounting';
import type { ColumnDef } from '@/types/data-table';
import type { SelectOption } from '@/types/select';

// Usage billing raises wallet events continuously: one refresh per window is enough.
const LIVE_REFRESH_MS = 3_000;

const { t } = useI18n();
const { fmt } = useMoney();
const router = useRouter();
const toast = useToast();
const applicationsStore = useApplicationsStore();

const entries = ref<JournalEntry[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(20);
const loading = ref(true);

const kind = ref<JournalKind | ''>('');
const userId = ref('');
const applicationId = ref('');
const fromDate = ref('');
const toDate = ref('');

const rangeError = computed(() =>
  fromDate.value && toDate.value && fromDate.value > toDate.value ? t('accounting.filters.invalidRange') : '',
);

const hasFilters = computed(() => Boolean(kind.value || userId.value || applicationId.value || fromDate.value || toDate.value));

function startOfLocalDay(date: string, plusDays = 0): string {
  const day = new Date(`${date}T00:00:00`);
  day.setDate(day.getDate() + plusDays);
  return day.toISOString();
}

const query = computed<JournalQuery>(() => ({
  page: page.value,
  limit: limit.value,
  kind: kind.value || undefined,
  userId: userId.value || undefined,
  applicationId: applicationId.value || undefined,
  from: fromDate.value ? startOfLocalDay(fromDate.value) : undefined,
  // The end date is inclusive for the reader, exclusive for the API.
  to: toDate.value ? startOfLocalDay(toDate.value, 1) : undefined,
}));

let latestRequest = 0;

async function fetchJournal(): Promise<void> {
  if (rangeError.value) return;
  const request = ++latestRequest;
  try {
    const res = await listJournal(query.value);
    if (request !== latestRequest) return;
    entries.value = res.entries;
    total.value = res.total;
  } catch (err) {
    if (request === latestRequest) toast.error(err instanceof Error ? err.message : t('accounting.loadError'));
  } finally {
    if (request === latestRequest) loading.value = false;
  }
}

watch([kind, userId, applicationId, fromDate, toDate], () => {
  // Leaving a later page already triggers the fetch through the page watcher.
  if (page.value === 1) void fetchJournal();
  else page.value = 1;
});
watch([page, limit], () => void fetchJournal());

function resetFilters(): void {
  kind.value = '';
  userId.value = '';
  applicationId.value = '';
  fromDate.value = '';
  toDate.value = '';
}

let liveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(): void {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void fetchJournal();
  }, LIVE_REFRESH_MS);
}
const events = useAdminEvents({ 'wallet.changed': scheduleRefresh, 'subscription.changed': scheduleRefresh });

onMounted(() => {
  void fetchJournal();
  void applicationsStore.fetchApplications();
});
onUnmounted(() => {
  if (liveTimer) clearTimeout(liveTimer);
  events.close();
});

async function loadUserOptions(search: string): Promise<SelectOption[]> {
  const res = await listUsers({ search: search || undefined, limit: 10 });
  return res.users.map((u) => ({
    value: u.id,
    label: u.name ?? u.email,
    description: u.email,
    avatar: { name: u.name ?? u.email, image: u.image },
  }));
}

const kindOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('accounting.filters.allKinds'), icon: Layers },
  ...JOURNAL_KINDS.map((k) => ({ value: k, label: t(`accounting.kinds.${k}`), icon: JOURNAL_KIND_META[k].icon })),
]);

const applicationOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('dashboard.allApplications'), icon: Layers },
  ...applicationsStore.applications.map((a) => ({ value: a.id, label: a.name, description: a.slug, icon: AppWindow })),
]);

const columns = computed<ColumnDef<JournalEntry>[]>(() => [
  { key: 'date', label: t('accounting.columns.date') },
  { key: 'kind', label: t('accounting.columns.kind') },
  { key: 'user', label: t('accounting.columns.user') },
  { key: 'details', label: t('accounting.columns.details') },
  { key: 'actor', label: t('accounting.columns.actor'), responsive: 'lg' },
  { key: 'application', label: t('accounting.columns.application'), responsive: 'xl' },
]);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function signedAmount(micro: string): string {
  return `${BigInt(micro) > 0n ? '+' : ''}${fmt(micro)}`;
}

function personName(person: JournalPerson): string {
  return person.name ?? person.email ?? person.id;
}

function sourceLabel(row: JournalEntry): string {
  return row.source ? t(`accounting.sources.${row.source}`) : '—';
}

function open(row: JournalEntry): void {
  if (row.owner.type === 'user') void router.push(`/users/${row.owner.id}`);
}
</script>

<template>
  <AppLayout :title="t('accounting.title')" :subtitle="t('accounting.subtitle')">
    <div class="space-y-5" data-testid="accounting-view">
      <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 space-y-4">
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <SearchSelect
            v-model="userId"
            :label="t('accounting.filters.user')"
            :placeholder="t('common.searchUsers')"
            :load-options="loadUserOptions"
          />
          <BaseSelect v-model="kind" :label="t('accounting.filters.kind')" :options="kindOptions" />
          <BaseSelect v-model="applicationId" :label="t('accounting.filters.application')" :options="applicationOptions" />
          <BaseInput v-model="fromDate" type="date" :label="t('accounting.filters.from')" />
          <BaseInput v-model="toDate" type="date" :label="t('accounting.filters.to')" :error="rangeError" />
        </div>
        <div class="flex justify-end gap-2">
          <BaseButton v-if="hasFilters" variant="ghost" size="sm" @click="resetFilters">
            {{ t('accounting.resetFilters') }}
          </BaseButton>
          <BaseButton variant="outline" size="sm" :loading="loading" @click="fetchJournal">
            <RefreshCw class="w-3.5 h-3.5" />{{ t('accounting.refresh') }}
          </BaseButton>
        </div>
      </section>

      <DataTable
        :columns="columns"
        :items="entries"
        :loading="loading"
        :empty="!loading && entries.length === 0"
        :row-key="(e: JournalEntry) => e.id"
        :pagination="{ page, limit, total }"
        clickable-rows
        @row-click="open"
        @update:page="(p: number) => (page = p)"
        @update:limit="(l: number) => { limit = l; page = 1; }"
      >
        <template #empty>
          <EmptyState :title="t('accounting.empty')" :message="t('accounting.emptyHint')" />
        </template>

        <template #cell-date="{ row }">
          <span class="text-xs text-surface-400 whitespace-nowrap">{{ formatDate(row.createdAt) }}</span>
        </template>

        <template #cell-kind="{ row }">
          <BaseBadge :variant="JOURNAL_KIND_META[row.kind].variant" size="sm">
            <component :is="JOURNAL_KIND_META[row.kind].icon" class="w-3 h-3" />
            {{ t(`accounting.kinds.${row.kind}`) }}
          </BaseBadge>
        </template>

        <template #cell-user="{ row }">
          <div class="min-w-0">
            <p class="text-sm text-surface-100 truncate">{{ personName(row.owner) }}</p>
            <p v-if="row.owner.type === 'org'" class="text-xs text-surface-500">{{ t('accounting.organization') }}</p>
            <p v-else-if="row.owner.name && row.owner.email" class="text-xs text-surface-500 truncate">{{ row.owner.email }}</p>
          </div>
        </template>

        <template #cell-details="{ row }">
          <div class="min-w-0 space-y-0.5">
            <p
              v-if="row.amount !== null"
              :class="['text-sm font-medium tabular-nums', BigInt(row.amount) < 0n ? 'text-red-400' : 'text-emerald-400']"
            >
              {{ signedAmount(row.amount) }}
            </p>
            <p v-else-if="isPlanKind(row.kind)" class="flex items-center gap-1.5 text-sm text-surface-100">
              <span :class="row.fromPlan ? '' : 'text-surface-500'">{{ row.fromPlan ?? '—' }}</span>
              <ArrowRight class="w-3.5 h-3.5 text-surface-500 shrink-0" />
              <span :class="row.toPlan ? '' : 'text-surface-500'">{{ row.toPlan ?? '—' }}</span>
            </p>
            <p v-if="row.balanceAfter !== null" class="text-xs text-surface-500 tabular-nums">
              {{ t('accounting.balanceAfter', { amount: fmt(row.balanceAfter) }) }}
            </p>
            <p v-if="row.reference" class="text-xs text-surface-400 truncate">{{ t('accounting.reference', { reference: row.reference }) }}</p>
            <p v-if="row.reason" class="text-xs text-surface-400 truncate max-w-xs" :title="row.reason">{{ row.reason }}</p>
          </div>
        </template>

        <template #cell-actor="{ row }">
          <div class="min-w-0">
            <p class="text-sm text-surface-200 truncate">{{ row.actor ? personName(row.actor) : sourceLabel(row) }}</p>
            <p v-if="row.actor && row.source" class="text-xs text-surface-500">{{ sourceLabel(row) }}</p>
          </div>
        </template>

        <template #cell-application="{ row }">
          <span class="text-sm text-surface-300">{{ row.application?.name ?? '—' }}</span>
        </template>
      </DataTable>
    </div>
  </AppLayout>
</template>
