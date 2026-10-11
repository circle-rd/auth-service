<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Wallet } from 'lucide-vue-next';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { useMoney } from '@/composables/useMoney';
import type { WalletAccount } from '@/types/wallet';

const props = defineProps<{
  account: WalletAccount | null;
  loading?: boolean;
}>();

const { t } = useI18n();
const { fmt } = useMoney();

type State = 'unlimited' | 'available' | 'debt' | 'empty';

const state = computed<State>(() => {
  const a = props.account;
  if (!a) return 'empty';
  if (a.isUnlimited) return 'unlimited';
  const balance = BigInt(a.balance);
  if (balance < 0n) return 'debt';
  return balance === 0n ? 'empty' : 'available';
});

const badge = computed(() => ({
  unlimited: { variant: 'info' as const, label: t('wallet.unlimited') },
  available: { variant: 'success' as const, label: t('wallet.available') },
  debt: { variant: 'error' as const, label: t('wallet.inDebt') },
  empty: { variant: 'warning' as const, label: t('wallet.exhausted') },
})[state.value]);

const hint = computed(() => ({
  unlimited: t('wallet.unlimitedHint'),
  available: t('wallet.availableHint'),
  debt: t('wallet.debtHint'),
  empty: t('wallet.emptyHint'),
})[state.value]);

const amountClass = computed(() =>
  state.value === 'debt' ? 'text-red-400' : state.value === 'empty' ? 'text-amber-300' : 'text-surface-50',
);
</script>

<template>
  <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6" data-testid="wallet-balance">
    <div class="flex items-start justify-between mb-3">
      <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">{{ t('wallet.balance') }}</p>
      <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
        <Wallet class="w-4 h-4 text-primary-400" />
      </div>
    </div>

    <div v-if="loading || !account" class="h-10 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-lg w-40 mb-3" />
    <p v-else :class="['text-4xl font-bold tabular-nums mb-3', amountClass]" data-testid="wallet-balance-amount">
      {{ account.isUnlimited && BigInt(account.balance) === 0n ? '∞' : fmt(account.balance) }}
    </p>

    <div v-if="account && !loading">
      <BaseBadge :variant="badge.variant" size="md" dot>{{ badge.label }}</BaseBadge>
      <p class="mt-3 text-sm text-surface-400">{{ hint }}</p>
    </div>

    <div v-if="$slots.actions" class="mt-5 flex flex-wrap gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
