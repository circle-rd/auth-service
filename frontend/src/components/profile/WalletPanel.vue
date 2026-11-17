<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Receipt, RefreshCw } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import InvoicesPanel from '@/components/profile/InvoicesPanel.vue';
import AutoTopupModal from '@/components/wallet/AutoTopupModal.vue';
import AutoTopupSummary from '@/components/wallet/AutoTopupSummary.vue';
import TopupAmountPicker from '@/components/wallet/TopupAmountPicker.vue';
import WalletBalanceCard from '@/components/wallet/WalletBalanceCard.vue';
import WalletSpendCard from '@/components/wallet/WalletSpendCard.vue';
import WalletDailyTable from '@/components/wallet/WalletDailyTable.vue';
import { createCheckout, getAutoTopup, getMySpendStats, getMyWallet, getTopupOptions, setAutoTopup } from '@/api/wallet';
import { useMoney } from '@/composables/useMoney';
import { useToast } from '@/composables/useToast';
import { useWalletData } from '@/composables/useWalletData';
import { eurToCents } from '@/utils/money';
import type { AutoTopup, TopupOptions } from '@/types/wallet';

// Users have no event channel (SSE is admin-only), so the panel polls while visible.
const POLL_MS = 15_000;
// After a payment the webhook lands asynchronously: poll faster for a short while.
const POST_PAYMENT_POLL_MS = 3_000;
const POST_PAYMENT_POLLS = 10;

const { t } = useI18n();
const { fmt } = useMoney();
const toast = useToast();
const route = useRoute();
const router = useRouter();

const { account, stats, loading, error, refresh: refreshWallet } = useWalletData({
  getAccount: getMyWallet,
  getStats: getMySpendStats,
}, 30);

const autoTopup = ref<AutoTopup | null>(null);
const showAutoTopup = ref(false);
const autoTopupBusy = ref(false);

async function loadAutoTopup(): Promise<void> {
  try {
    autoTopup.value = await getAutoTopup();
  } catch {
    // The wallet itself still shows; the option just stays unavailable.
  }
}

async function refresh(): Promise<void> {
  await Promise.all([refreshWallet(), loadAutoTopup()]);
}

const options = ref<TopupOptions | null>(null);
const amount = ref('10');
const amountError = ref('');
const redirecting = ref(false);
const showInvoices = ref(false);

const cents = computed(() => eurToCents(amount.value));
const inRange = computed(() =>
  options.value !== null && cents.value !== null &&
  cents.value >= options.value.minCents && cents.value <= options.value.maxCents,
);
const rangeLabel = computed(() => ({
  min: options.value ? fmt(BigInt(options.value.minCents) * 10_000n) : '',
  max: options.value ? fmt(BigInt(options.value.maxCents) * 10_000n) : '',
}));

const showAutoTopupSection = computed(() =>
  options.value?.enabled === true && account.value !== null && !account.value.isUnlimited,
);

async function saveAutoTopup(amountCents: number | null): Promise<void> {
  autoTopupBusy.value = true;
  try {
    const result = await setAutoTopup(amountCents);
    if (result.setupUrl) {
      window.location.assign(result.setupUrl);
      return;
    }
    autoTopup.value = result.autoTopup;
    showAutoTopup.value = false;
    toast.success(t(amountCents === null ? 'wallet.autoTopup.turnedOff' : 'wallet.autoTopup.turnedOn'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.autoTopup.error'));
  } finally {
    autoTopupBusy.value = false;
  }
}

watch(amount, () => {
  amountError.value = '';
});

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
  const autoOutcome = route.query.autotopup;
  if (outcome === 'success') {
    toast.success(t('wallet.topup.success'));
    fastPolls = POST_PAYMENT_POLLS;
  } else if (outcome === 'cancelled') {
    toast.info(t('wallet.topup.cancelled'));
  }
  if (autoOutcome === 'success') {
    toast.success(t('wallet.autoTopup.savedCard'));
    // The webhook turns the option on a moment after the return.
    fastPolls = POST_PAYMENT_POLLS;
  } else if (autoOutcome === 'cancelled') {
    toast.info(t('wallet.autoTopup.cancelled'));
  }
  if (outcome !== undefined || autoOutcome !== undefined) {
    // Drop the markers so a reload does not replay the message.
    const { topup: _topup, autotopup: _autotopup, ...rest } = route.query;
    await router.replace({ query: rest });
  }
  await Promise.all([refresh(), getTopupOptions().then((o) => { options.value = o; }).catch(() => {
    options.value = { enabled: false, currency: 'eur', minCents: 0, maxCents: 0, autoTopupTermsUrl: null };
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
    <div v-if="error && !account" class="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 sm:p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p class="text-sm text-red-300">{{ t('wallet.loadError') }}</p>
      <BaseButton variant="outline" size="sm" @click="refresh">{{ t('wallet.refresh') }}</BaseButton>
    </div>

    <div class="grid lg:grid-cols-2 gap-5">
      <WalletBalanceCard :account="account" :loading="loading">
        <template #actions>
          <BaseButton variant="ghost" size="sm" @click="refresh">
            <RefreshCw class="w-3.5 h-3.5" /> {{ t('wallet.refresh') }}
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="showInvoices = true">
            <Receipt class="w-3.5 h-3.5" /> {{ t('wallet.invoices') }}
          </BaseButton>
        </template>
        <template v-if="showAutoTopupSection" #footer>
          <AutoTopupSummary
            :auto-topup="autoTopup"
            :busy="autoTopupBusy"
            @configure="showAutoTopup = true"
            @disable="saveAutoTopup(null)"
          />
        </template>
      </WalletBalanceCard>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-6" data-testid="wallet-topup">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('wallet.topup.title') }}</h3>

        <template v-if="options?.enabled">
          <TopupAmountPicker v-model="amount" :options="options" :error="amountError" />
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
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('wallet.daily.title') }}</h3>
      </div>
      <WalletDailyTable :daily="stats?.daily ?? []" :loading="loading" />
    </div>

    <BaseModal :open="showInvoices" :title="t('profile.billingPanel.invoicesTitle')" size="xl" @close="showInvoices = false">
      <InvoicesPanel />
    </BaseModal>

    <AutoTopupModal
      v-if="options?.enabled"
      :open="showAutoTopup"
      :options="options"
      :current="autoTopup"
      :saving="autoTopupBusy"
      @close="showAutoTopup = false"
      @submit="saveAutoTopup"
    />
  </div>
</template>
