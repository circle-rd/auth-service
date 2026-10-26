<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { RefreshCw } from 'lucide-vue-next';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import WalletBalanceCard from '@/components/wallet/WalletBalanceCard.vue';
import WalletSpendCard from '@/components/wallet/WalletSpendCard.vue';
import WalletTransactionList from '@/components/wallet/WalletTransactionList.vue';
import { createCheckout, getMySpendStats, getMyTransactions, getMyWallet, getTopupOptions } from '@/api/wallet';
import { useMoney } from '@/composables/useMoney';
import { useToast } from '@/composables/useToast';
import { useWalletData } from '@/composables/useWalletData';
import { PAGE_SIZE_OPTIONS, usePersistentPageSize } from '@/composables/usePersistentPageSize';
import { eurToCents } from '@/utils/money';
import type { TopupOptions } from '@/types/wallet';

// Users have no event channel (SSE is admin-only), so the panel polls while visible.
const POLL_MS = 15_000;
// After a payment the webhook lands asynchronously: poll faster for a short while.
const POST_PAYMENT_POLL_MS = 3_000;
const POST_PAYMENT_POLLS = 10;
const PRESET_EUR = [5, 10, 25, 50];

const { t } = useI18n();
const { fmt } = useMoney();
const toast = useToast();
const route = useRoute();
const router = useRouter();

const pageSize = usePersistentPageSize('wallet-my-transactions', 20);
const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: String(size) }));
const { account, stats, items, nextCursor, loading, loadingMore, error, refresh, loadMore } = useWalletData({
  getAccount: getMyWallet,
  getStats: getMySpendStats,
  getPage: getMyTransactions,
}, 30, pageSize);

watch(pageSize, () => void refresh());

const options = ref<TopupOptions | null>(null);
const amount = ref('10');
const amountError = ref('');
const redirecting = ref(false);

const cents = computed(() => eurToCents(amount.value));
const inRange = computed(() =>
  options.value !== null && cents.value !== null &&
  cents.value >= options.value.minCents && cents.value <= options.value.maxCents,
);
const rangeLabel = computed(() => ({
  min: options.value ? fmt(BigInt(options.value.minCents) * 10_000n) : '',
  max: options.value ? fmt(BigInt(options.value.maxCents) * 10_000n) : '',
}));

function pickPreset(eur: number): void {
  amount.value = String(eur);
  amountError.value = '';
}

async function startCheckout(): Promise<void> {
  if (!inRange.value || cents.value === null) {
    amountError.value = t('wallet.topup.invalidAmount', rangeLabel.value);
    return;
  }
  amountError.value = '';
  redirecting.value = true;
  try {
    const { url } = await createCheckout(cents.value);
    window.location.assign(url);
  } catch (err) {
    redirecting.value = false;
    toast.error(err instanceof Error ? err.message : t('wallet.topup.error'));
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let fastPolls = 0;
let stopped = false;

function schedule(): void {
  if (stopped) return;
  const delay = fastPolls > 0 ? POST_PAYMENT_POLL_MS : POLL_MS;
  timer = setTimeout(async () => {
    if (fastPolls > 0) fastPolls -= 1;
    if (!document.hidden) await refresh();
    schedule();
  }, delay);
}

function onVisible(): void {
  if (!document.hidden) void refresh();
}

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisible);
  const outcome = route.query.topup;
  if (outcome === 'success') {
    toast.success(t('wallet.topup.success'));
    fastPolls = POST_PAYMENT_POLLS;
  } else if (outcome === 'cancelled') {
    toast.info(t('wallet.topup.cancelled'));
  }
  if (outcome !== undefined) {
    // Drop the marker so a reload does not replay the message.
    const { topup: _topup, ...rest } = route.query;
    await router.replace({ query: rest });
  }
  await Promise.all([refresh(), getTopupOptions().then((o) => { options.value = o; }).catch(() => {
    options.value = { enabled: false, currency: 'eur', minCents: 0, maxCents: 0 };
  })]);
  schedule();
});

onUnmounted(() => {
  stopped = true;
  if (timer) clearTimeout(timer);
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<template>
  <div class="space-y-5" data-testid="wallet-panel">
    <div v-if="error && !account" class="rounded-2xl border border-red-500/30 bg-red-500/10 p-5 flex items-center justify-between gap-4">
      <p class="text-sm text-red-300">{{ t('wallet.loadError') }}</p>
      <BaseButton variant="outline" size="sm" @click="refresh">{{ t('wallet.refresh') }}</BaseButton>
    </div>

    <div class="grid lg:grid-cols-2 gap-5">
      <WalletBalanceCard :account="account" :loading="loading">
        <template #actions>
          <BaseButton variant="ghost" size="sm" @click="refresh">
            <RefreshCw class="w-3.5 h-3.5" /> {{ t('wallet.refresh') }}
          </BaseButton>
        </template>
      </WalletBalanceCard>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6" data-testid="wallet-topup">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('wallet.topup.title') }}</h3>

        <template v-if="options?.enabled">
          <div class="flex flex-wrap gap-2 mb-4">
            <button
              v-for="eur in PRESET_EUR"
              :key="eur"
              type="button"
              :class="[
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                amount === String(eur)
                  ? 'bg-primary-600/20 border-primary-500/50 text-primary-300'
                  : 'border-surface-700 text-surface-300 hover:bg-surface-800',
              ]"
              @click="pickPreset(eur)"
            >{{ fmt(BigInt(eur) * 1_000_000n) }}</button>
          </div>
          <BaseInput
            v-model="amount"
            :label="t('wallet.topup.amount')"
            inputmode="decimal"
            :error="amountError"
            :hint="t('wallet.topup.range', rangeLabel)"
          />
          <BaseButton class="mt-4 w-full" :loading="redirecting" :disabled="!inRange" @click="startCheckout">
            {{ redirecting ? t('wallet.topup.redirecting') : t('wallet.topup.buy') }}
          </BaseButton>
          <p class="mt-3 text-xs text-surface-500">{{ t('wallet.topup.localCurrency') }}</p>
        </template>

        <template v-else-if="options">
          <p class="text-sm font-medium text-surface-200">{{ t('wallet.topup.unavailableTitle') }}</p>
          <p class="mt-1 text-sm text-surface-400">{{ t('wallet.topup.unavailableBody') }}</p>
        </template>

        <div v-else class="h-24 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />
      </div>
    </div>

    <WalletSpendCard :stats="stats" :loading="loading" />

    <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
      <div class="px-5 py-4 border-b border-surface-700/40">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('wallet.history.title') }}</h3>
      </div>
      <WalletTransactionList
        :items="items"
        :loading="loading"
        :has-more="nextCursor !== null"
        :loading-more="loadingMore"
        :page-size="pageSize"
        :page-size-options="pageSizeOptions"
        @load-more="loadMore"
        @update:page-size="pageSize = $event"
      />
    </div>
  </div>
</template>
