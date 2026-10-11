<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import DataTable from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useMoney } from '@/composables/useMoney';
import { applicationOf, describeTransaction, typeVariant } from '@/utils/walletTransaction';
import type { ColumnDef } from '@/types/data-table';
import type { WalletTransaction } from '@/types/wallet';

defineProps<{
  items: WalletTransaction[];
  loading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
}>();

const emit = defineEmits<{ 'load-more': [] }>();

const { t, locale } = useI18n();
const { fmt } = useMoney();

const columns = computed<ColumnDef<WalletTransaction>[]>(() => [
  { key: 'date', label: t('wallet.history.date') },
  { key: 'type', label: t('wallet.history.type') },
  { key: 'details', label: t('wallet.history.details'), responsive: 'md' },
  { key: 'application', label: t('wallet.history.application'), responsive: 'lg' },
  { key: 'amount', label: t('wallet.history.amount'), align: 'right' },
  { key: 'balance', label: t('wallet.history.balanceAfter'), align: 'right', responsive: 'sm' },
]);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' });
}

function amountClass(tx: WalletTransaction): string {
  const value = BigInt(tx.amount);
  return value > 0n ? 'text-emerald-400' : 'text-surface-200';
}

function signed(tx: WalletTransaction): string {
  const value = BigInt(tx.amount);
  return `${value > 0n ? '+' : ''}${fmt(value)}`;
}
</script>

<template>
  <div data-testid="wallet-history">
    <DataTable
      :columns="columns"
      :items="items"
      :loading="loading"
      :empty="!loading && items.length === 0"
      :row-key="(tx: WalletTransaction) => tx.id"
    >
      <template #empty>
        <EmptyState :title="t('wallet.history.title')" :message="t('wallet.history.empty')" />
      </template>
      <template #cell-date="{ row }">
        <span class="text-xs text-surface-400 whitespace-nowrap">{{ formatDate(row.createdAt) }}</span>
      </template>
      <template #cell-type="{ row }">
        <BaseBadge :variant="typeVariant(row.type)" size="sm">
          {{ t(`wallet.history.types.${row.type}`) }}
        </BaseBadge>
      </template>
      <template #cell-details="{ row }">
        <span class="text-xs text-surface-400 truncate block max-w-[22rem]">{{ describeTransaction(row, t) || '—' }}</span>
      </template>
      <template #cell-application="{ row }">
        <span class="text-xs text-surface-500 font-mono">{{ applicationOf(row) ?? '—' }}</span>
      </template>
      <template #cell-amount="{ row }">
        <div class="text-right">
          <span :class="['text-sm font-medium tabular-nums whitespace-nowrap', amountClass(row)]">{{ signed(row) }}</span>
          <p v-if="row.delta === '0'" class="text-[11px] text-surface-600">{{ t('wallet.history.notDeducted') }}</p>
        </div>
      </template>
      <template #cell-balance="{ row }">
        <span :class="['text-xs tabular-nums', BigInt(row.balanceAfter) < 0n ? 'text-red-400' : 'text-surface-500']">
          {{ fmt(row.balanceAfter) }}
        </span>
      </template>
    </DataTable>

    <div v-if="hasMore" class="flex justify-center pt-3">
      <BaseButton variant="outline" size="sm" :loading="loadingMore" @click="emit('load-more')">
        {{ t('wallet.history.loadMore') }}
      </BaseButton>
    </div>
  </div>
</template>
