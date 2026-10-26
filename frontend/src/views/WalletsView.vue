<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Coins, TrendingDown, Receipt, Wallet } from 'lucide-vue-next';
import AppLayout from '@/components/layout/AppLayout.vue';
import StatCard from '@/components/ui/StatCard.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import DataTable from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SpendChart from '@/components/wallet/SpendChart.vue';
import SpendBreakdown from '@/components/wallet/SpendBreakdown.vue';
import PricingCard from '@/components/wallet/PricingCard.vue';
import { getWalletStats, listWallets } from '@/api/wallet';
import { useAdminEvents } from '@/composables/useAdminEvents';
import { useDebounce } from '@/composables/useDebounce';
import { useMoney } from '@/composables/useMoney';
import { useToast } from '@/composables/useToast';
import { usePersistentPageSize } from '@/composables/usePersistentPageSize';
import type { ColumnDef } from '@/types/data-table';
import type { AdminWalletStats, WalletListFilter, WalletListItem } from '@/types/wallet';

const FILTERS: WalletListFilter[] = ['all', 'debt', 'credit', 'unlimited'];
const DAYS = 30;
const POLL_MS = 30_000;

const { t } = useI18n();
const { fmt } = useMoney();
const router = useRouter();
const toast = useToast();

const stats = ref<AdminWalletStats | null>(null);
const wallets = ref<WalletListItem[]>([]);
const total = ref(0);
const page = ref(1);
const limit = usePersistentPageSize('admin-wallets', 20);
const filter = ref<WalletListFilter>('all');
const search = ref('');
const debouncedSearch = useDebounce(search, 300);
const loading = ref(true);

async function fetchStats(): Promise<void> {
  try {
    stats.value = await getWalletStats(DAYS);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.loadError'));
  }
}

async function fetchList(): Promise<void> {
  try {
    const res = await listWallets({
      page: page.value,
      limit: limit.value,
      filter: filter.value,
      search: debouncedSearch.value || undefined,
    });
    wallets.value = res.wallets;
    total.value = res.total;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.loadError'));
  } finally {
    loading.value = false;
  }
}

function refreshAll(): void {
  void fetchStats();
  void fetchList();
}

watch([filter, debouncedSearch], () => {
  // Leaving a later page already triggers the fetch through the page watcher.
  if (page.value === 1) void fetchList();
  else page.value = 1;
});
watch([page, limit], () => void fetchList());

const events = useAdminEvents({ 'wallet.changed': refreshAll });
let poll: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  refreshAll();
  poll = setInterval(() => { if (!document.hidden) refreshAll(); }, POLL_MS);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
  events.close();
});

const columns = computed<ColumnDef<WalletListItem>[]>(() => [
  { key: 'user', label: t('wallet.admin.columns.user') },
  { key: 'balance', label: t('wallet.admin.columns.balance'), align: 'right' },
  { key: 'spent', label: t('wallet.admin.columns.spent'), align: 'right', responsive: 'md' },
  { key: 'status', label: t('wallet.admin.columns.status'), responsive: 'sm' },
  { key: 'updated', label: t('wallet.admin.columns.updated'), responsive: 'lg' },
]);

const filterOptions = computed(() =>
  FILTERS.map((f) => ({ key: f, label: t(`wallet.admin.filters.${f}`) })),
);

function open(row: WalletListItem): void {
  if (row.ownerType === 'user') void router.push(`/users/${row.ownerId}`);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
  <AppLayout :title="t('wallet.admin.title')" :subtitle="t('wallet.admin.subtitle')">
    <div class="space-y-6" data-testid="wallets-view">
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          :label="t('wallet.admin.credit')"
          :value="stats ? fmt(stats.totals.outstandingCredit) : ''"
          :sub="t('wallet.admin.creditSub')"
          :loading="!stats"
          :icon="Wallet"
        />
        <StatCard
          :label="t('wallet.admin.debt')"
          :value="stats ? fmt(stats.totals.outstandingDebt) : ''"
          :sub="stats ? t('wallet.admin.debtSub', { count: stats.totals.accountsInDebt }) : ''"
          :loading="!stats"
          :icon="TrendingDown"
        />
        <StatCard
          :label="t('wallet.admin.spend')"
          :value="stats ? fmt(stats.spend.total) : ''"
          :sub="stats ? t('wallet.admin.spendSub', { days: stats.days, count: stats.spend.calls }) : ''"
          :loading="!stats"
          :icon="Coins"
        />
        <StatCard
          :label="t('wallet.admin.topups')"
          :value="stats ? fmt(stats.topUps.total) : ''"
          :sub="stats ? t('wallet.admin.topupsSub', { days: stats.days, count: stats.topUps.count }) : ''"
          :loading="!stats"
          :icon="Receipt"
        />
      </div>

      <PricingCard />

      <div class="grid xl:grid-cols-3 gap-5">
        <div class="xl:col-span-2 rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6">
          <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('wallet.dashboard.chart') }}</h3>
          <SpendChart :series="stats?.spend.series ?? []" :loading="!stats">
            <template #empty>{{ t('wallet.spend.none') }}</template>
          </SpendChart>
          <div v-if="stats && stats.spend.calls > 0" class="mt-6 pt-6 border-t border-surface-700/40">
            <SpendBreakdown :by-application="stats.byApplication" :by-kind="stats.byKind" />
          </div>
        </div>

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6">
          <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('wallet.admin.topConsumers') }}</h3>
          <p v-if="stats && stats.topConsumers.length === 0" class="text-sm text-surface-500">{{ t('wallet.spend.none') }}</p>
          <ul v-else class="space-y-3">
            <li v-for="c in stats?.topConsumers ?? []" :key="c.ownerId" class="flex items-baseline justify-between gap-3 text-sm">
              <RouterLink v-if="c.ownerType === 'user'" :to="`/users/${c.ownerId}`" class="text-surface-200 hover:text-primary-300 truncate">
                {{ c.name ?? c.email ?? c.ownerId }}
              </RouterLink>
              <span v-else class="text-surface-200 truncate">{{ c.name ?? c.ownerId }}</span>
              <span class="text-surface-400 tabular-nums shrink-0">{{ fmt(c.amount) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40 flex flex-wrap items-center gap-3">
          <div class="flex gap-1 p-1 bg-surface-950/40 rounded-lg">
            <button
              v-for="f in filterOptions"
              :key="f.key"
              type="button"
              :class="[
                'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                filter === f.key ? 'bg-primary-600/20 text-primary-300' : 'text-surface-400 hover:text-surface-200',
              ]"
              @click="filter = f.key"
            >{{ f.label }}</button>
          </div>
          <input
            v-model="search"
            type="search"
            :placeholder="t('wallet.admin.searchPlaceholder')"
            class="ml-auto w-full sm:w-64 rounded-lg px-3 py-1.5 text-sm bg-surface-800 border border-surface-700 text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
          />
        </div>

        <DataTable
          :columns="columns"
          :items="wallets"
          :loading="loading"
          :empty="!loading && wallets.length === 0"
          :row-key="(w: WalletListItem) => w.id"
          :pagination="{ page, limit, total }"
          clickable-rows
          @row-click="open"
          @update:page="(p: number) => (page = p)"
          @update:limit="(l: number) => { limit = l; page = 1; }"
        >
          <template #empty>
            <EmptyState :title="t('wallet.admin.title')" :message="t('wallet.admin.noWallets')" />
          </template>
          <template #cell-user="{ row }">
            <div class="min-w-0">
              <p class="text-sm text-surface-100 truncate">{{ row.name ?? row.email ?? row.ownerId }}</p>
              <p v-if="row.ownerType !== 'user'" class="text-xs text-surface-500">{{ t('wallet.admin.organization') }}</p>
              <p v-else-if="row.name && row.email" class="text-xs text-surface-500 truncate">{{ row.email }}</p>
            </div>
          </template>
          <template #cell-balance="{ row }">
            <span :class="['text-sm font-medium tabular-nums', BigInt(row.balance) < 0n ? 'text-red-400' : 'text-surface-100']">
              {{ row.isUnlimited && BigInt(row.balance) === 0n ? '∞' : fmt(row.balance) }}
            </span>
          </template>
          <template #cell-spent="{ row }">
            <span class="text-xs text-surface-400 tabular-nums">{{ fmt(row.spent30d) }}</span>
          </template>
          <template #cell-status="{ row }">
            <BaseBadge :variant="row.isUnlimited ? 'info' : row.canSpend ? 'success' : 'error'" size="sm">
              {{ row.isUnlimited ? t('wallet.admin.status.unlimited') : row.canSpend ? t('wallet.admin.status.ok') : t('wallet.admin.status.blocked') }}
            </BaseBadge>
          </template>
          <template #cell-updated="{ row }">
            <span class="text-xs text-surface-500">{{ formatDate(row.updatedAt) }}</span>
          </template>
        </DataTable>
      </div>
    </div>
  </AppLayout>
</template>
