<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle } from 'lucide-vue-next';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import PricingModal from '@/components/wallet/PricingModal.vue';
import { getPricing } from '@/api/wallet';
import { useAuthStore } from '@/stores/auth';
import { useMoney } from '@/composables/useMoney';
import { useToast } from '@/composables/useToast';
import { pricedOneDollar } from '@/utils/money';
import type { PricingResponse } from '@/types/wallet';

const { t, locale } = useI18n();
const { fmt } = useMoney();
const auth = useAuthStore();
const toast = useToast();

const pricing = ref<PricingResponse | null>(null);
const loading = ref(true);
const editing = ref(false);
const showHistory = ref(false);

async function load(): Promise<void> {
  try {
    pricing.value = await getPricing();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.pricing.loadError'));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const current = computed(() => pricing.value?.current ?? null);
const example = computed(() =>
  current.value ? fmt(pricedOneDollar(current.value.usdToEurRate, current.value.marginPercent)) : '',
);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(locale.value, { dateStyle: 'medium' });
}

function actorName(name: string | null): string {
  return name ?? t('wallet.pricing.unknownActor');
}
</script>

<template>
  <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6" data-testid="pricing-card">
    <div class="flex items-start justify-between gap-4 mb-4">
      <div>
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('wallet.pricing.title') }}</h3>
        <p class="mt-1 text-xs text-surface-500 max-w-xl">{{ t('wallet.pricing.hint') }}</p>
      </div>
      <BaseButton v-if="auth.isSuperAdmin() && pricing" size="sm" variant="outline" @click="editing = true">
        {{ t('wallet.pricing.edit') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-16 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />

    <div v-else-if="pricing && !current" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300">
      <AlertTriangle class="w-4 h-4 mt-0.5 shrink-0" />
      <p class="text-sm">{{ t('wallet.pricing.notSet') }}</p>
    </div>

    <div v-else-if="current" class="space-y-4">
      <div class="grid grid-cols-2 gap-6">
        <div>
          <p class="text-xs text-surface-500">{{ t('wallet.pricing.rate') }}</p>
          <p class="mt-1 text-lg font-semibold text-surface-50 tabular-nums">{{ t('wallet.pricing.rateValue', { rate: current.usdToEurRate }) }}</p>
        </div>
        <div>
          <p class="text-xs text-surface-500">{{ t('wallet.pricing.margin') }}</p>
          <p class="mt-1 text-lg font-semibold text-surface-50 tabular-nums">{{ t('wallet.pricing.marginValue', { margin: current.marginPercent }) }}</p>
        </div>
      </div>
      <p class="text-sm text-surface-300">{{ t('wallet.pricing.example', { amount: example }) }}</p>
      <div class="flex flex-wrap items-center gap-2 text-xs text-surface-500">
        <BaseBadge :variant="current.source === 'database' ? 'success' : 'neutral'" size="sm">
          {{ t(`wallet.pricing.source.${current.source}`) }}
        </BaseBadge>
        <span v-if="current.change">
          {{ t('wallet.pricing.lastChange', { name: actorName(current.change.actor.name), date: formatDate(current.change.createdAt) }) }}
        </span>
      </div>
    </div>

    <div v-if="pricing && pricing.history.length > 0" class="mt-4 pt-4 border-t border-surface-700/40">
      <button type="button" class="text-xs text-primary-400 hover:text-primary-300" @click="showHistory = !showHistory">
        {{ showHistory ? t('wallet.pricing.hideHistory') : t('wallet.pricing.showHistory') }}
      </button>
      <ul v-if="showHistory" class="mt-3 space-y-2">
        <li v-for="h in pricing.history" :key="h.id" class="text-xs text-surface-400">
          <span class="text-surface-200 tabular-nums">{{ t('wallet.pricing.rateValue', { rate: h.usdToEurRate }) }} · {{ t('wallet.pricing.marginValue', { margin: h.marginPercent }) }}</span>
          — {{ h.reason }}
          <span class="text-surface-500">({{ actorName(h.actor.name) }}, {{ formatDate(h.createdAt) }})</span>
        </li>
      </ul>
    </div>

    <PricingModal :open="editing" :current="current" @close="editing = false" @done="load" />
  </div>
</template>
