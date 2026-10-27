<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { BarChart3 } from 'lucide-vue-next';
import BaseModal from '@/components/ui/BaseModal.vue';
import { useMoney } from '@/composables/useMoney';
import { applicationColor } from '@/utils/chartPalette';
import type { WalletSpendDay } from '@/types/wallet';

const props = defineProps<{
  daily: WalletSpendDay[];
  loading?: boolean;
}>();

const { t, locale } = useI18n();
const { fmt } = useMoney();

const openDay = ref<WalletSpendDay | null>(null);

const modelLabel = (model: string): string =>
  model === 'mcp' || model === 'other' ? t(`wallet.spend.models.${model}`) : model;

const fmtDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(locale.value, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** Days that actually spent something, newest first: a zero day says nothing. */
const days = computed(() =>
  props.daily.filter((d) => d.count > 0).slice().reverse(),
);

function segments(day: WalletSpendDay): { key: string; label: string; color: string; share: number }[] {
  const total = BigInt(day.amount);
  if (total === 0n) return [];
  return day.byApplication
    .map((a) => {
      const key = a.applicationId ?? a.slug ?? 'unknown';
      return {
        key,
        label: a.name ?? a.slug ?? t('wallet.spend.unknownApp'),
        color: applicationColor(key),
        share: Number((BigInt(a.amount) * 1000n) / total) / 10,
      };
    })
    .sort((a, b) => b.share - a.share);
}
</script>

<template>
  <div data-testid="wallet-daily">
    <div v-if="loading" class="p-5 space-y-3">
      <div v-for="i in 4" :key="i" class="h-8 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-lg" />
    </div>

    <div v-else-if="days.length === 0" class="px-5 py-10 text-center text-sm text-surface-500">
      {{ t('wallet.daily.empty') }}
    </div>

    <ul v-else class="divide-y divide-surface-700/30">
      <li
        v-for="day in days"
        :key="day.date"
        class="flex items-center gap-4 px-5 py-3"
        :data-testid="`wallet-day-${day.date}`"
      >
        <div class="w-28 shrink-0 text-sm text-surface-200">{{ fmtDate(day.date) }}</div>

        <div class="flex-1 min-w-0">
          <div class="flex h-2 rounded-full overflow-hidden bg-surface-800">
            <div
              v-for="seg in segments(day)"
              :key="seg.key"
              class="h-full"
              :style="{ width: `${seg.share}%`, backgroundColor: seg.color }"
              :title="seg.label"
            />
          </div>
          <p class="mt-1 text-xs text-surface-500 truncate">
            {{ segments(day).map((s) => s.label).join(' · ') }}
          </p>
        </div>

        <div class="w-28 shrink-0 text-right">
          <p class="text-sm tabular-nums text-surface-100">{{ fmt(day.amount) }}</p>
          <p class="text-xs text-surface-500">{{ t('wallet.spend.calls', { count: day.count }) }}</p>
        </div>

        <button
          type="button"
          class="shrink-0 p-2 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-surface-800"
          :title="t('wallet.daily.details')"
          @click="openDay = day"
        >
          <BarChart3 class="w-4 h-4" />
        </button>
      </li>
    </ul>

    <BaseModal
      :open="openDay !== null"
      :title="openDay ? fmtDate(openDay.date) : ''"
      size="lg"
      @close="openDay = null"
    >
      <div v-if="openDay" class="space-y-6">
        <div class="flex items-baseline justify-between">
          <span class="text-xs font-medium text-surface-500 uppercase tracking-wider">{{ t('wallet.daily.dayTotal') }}</span>
          <span class="text-lg font-semibold tabular-nums text-surface-50">{{ fmt(openDay.amount) }}</span>
        </div>

        <section>
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-3">{{ t('wallet.spend.byApplication') }}</p>
          <ul class="space-y-2">
            <li
              v-for="seg in segments(openDay)"
              :key="seg.key"
              class="flex items-center gap-3 text-sm"
            >
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: seg.color }" />
              <span class="flex-1 truncate text-surface-200">{{ seg.label }}</span>
              <span class="tabular-nums text-surface-300">
                {{ fmt(String(openDay.byApplication.find((a) => (a.applicationId ?? a.slug ?? 'unknown') === seg.key)?.amount ?? '0')) }}
              </span>
            </li>
          </ul>
        </section>

        <section>
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-3">{{ t('wallet.spend.byModel') }}</p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-xs text-surface-500 uppercase tracking-wider">
                  <th class="text-left font-medium py-2">{{ t('wallet.daily.model') }}</th>
                  <th class="text-right font-medium py-2">{{ t('wallet.daily.promptTokens') }}</th>
                  <th class="text-right font-medium py-2">{{ t('wallet.daily.completionTokens') }}</th>
                  <th class="text-right font-medium py-2">{{ t('wallet.daily.totalTokens') }}</th>
                  <th class="text-right font-medium py-2">{{ t('wallet.history.amount') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-700/30">
                <tr v-for="m in openDay.byModel" :key="m.model">
                  <td class="py-2 text-surface-200">{{ modelLabel(m.model) }}</td>
                  <td class="py-2 text-right tabular-nums text-surface-400">{{ m.promptTokens.toLocaleString(locale) }}</td>
                  <td class="py-2 text-right tabular-nums text-surface-400">{{ m.completionTokens.toLocaleString(locale) }}</td>
                  <td class="py-2 text-right tabular-nums text-surface-400">{{ m.totalTokens.toLocaleString(locale) }}</td>
                  <td class="py-2 text-right tabular-nums text-surface-100">{{ fmt(m.amount) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </BaseModal>
  </div>
</template>
