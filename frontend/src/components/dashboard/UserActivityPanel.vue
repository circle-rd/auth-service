<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Activity, Coins, ShieldAlert, Share2 } from '@lucide/vue';
import StatCard from '@/components/ui/StatCard.vue';
import { getUserActivity, type MonitoringRange, type UserActivity } from '@/api/monitoring';
import { useCatalogueActivityTick } from '@/composables/useCatalogueActivity';
import DecisionChart from './DecisionChart.vue';
import RankList, { type RankItem } from './RankList.vue';

const props = defineProps<{ appId: string }>();

const { t, n } = useI18n();

const range = ref<MonitoringRange>('7d');
const activity = ref<UserActivity | null>(null);
const failed = ref(false);

async function load() {
  activity.value = null;
  failed.value = false;
  try {
    activity.value = await getUserActivity(props.appId, range.value);
  } catch {
    failed.value = true;
  }
}

const activityTick = useCatalogueActivityTick();
watch([() => props.appId, range, () => activityTick?.value], () => void load(), { immediate: true });

const usedSeries = computed(() => (activity.value?.used.series ?? []).map((point) => ({ date: point.date, allow: point.calls })));

const sharedItems = computed<RankItem[]>(() =>
  (activity.value?.shared.topResources ?? []).map((entry) => ({ key: entry.uri, label: entry.uri, value: entry.calls })),
);
const usedItems = computed<RankItem[]>(() =>
  (activity.value?.used.topResources ?? []).map((entry) => ({ key: entry.uri, label: entry.uri, value: entry.calls })),
);
</script>

<template>
  <section class="space-y-6" data-testid="user-activity">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <h2 class="text-sm font-semibold text-surface-200">{{ t('dashboard.user.title') }}</h2>
      <div class="flex gap-1">
        <button
          v-for="value in (['7d', '30d'] as const)"
          :key="value"
          type="button"
          :class="['px-2.5 py-1 rounded-lg text-xs font-medium transition-colors', range === value ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-300']"
          @click="range = value"
        >
          {{ t(`dashboard.timeRanges.${value}`) }}
        </button>
      </div>
    </div>

    <p v-if="failed" class="text-sm text-amber-400">{{ t('dashboard.user.unavailable') }}</p>

    <template v-else>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          :label="t('dashboard.user.reached')"
          :value="activity?.shared.allow ?? ''"
          :loading="!activity"
          :icon="Share2"
          :sub="activity ? t('dashboard.user.sharedTokens', { count: n(activity.shared.totalTokens) }) : ''"
        />
        <StatCard :label="t('dashboard.user.refused')" :value="activity?.shared.deny ?? ''" :loading="!activity" :icon="ShieldAlert" />
        <StatCard :label="t('dashboard.user.myCalls')" :value="activity?.used.calls ?? ''" :loading="!activity" :icon="Activity" />
        <StatCard
          :label="t('dashboard.user.myConsumption')"
          :value="activity ? n(activity.used.totalTokens) : ''"
          :loading="!activity"
          :icon="Coins"
          :sub="activity ? `$${Number(activity.used.costUsd).toFixed(4)}` : ''"
        />
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <h3 class="text-sm font-semibold text-surface-200 mb-4">{{ t('dashboard.user.sharedChart') }}</h3>
          <DecisionChart
            :series="activity?.shared.series ?? []"
            :allow-label="t('share.access.decisions.allow')"
            :deny-label="t('share.access.decisions.deny')"
            :loading="!activity"
          >
            <template #empty>{{ t('dashboard.user.nothingShared') }}</template>
          </DecisionChart>
        </div>
        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <h3 class="text-sm font-semibold text-surface-200 mb-4">{{ t('dashboard.user.usedChart') }}</h3>
          <DecisionChart :series="usedSeries" :allow-label="t('dashboard.user.calls')" :loading="!activity">
            <template #empty>{{ t('dashboard.user.nothingUsed') }}</template>
          </DecisionChart>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RankList :title="t('dashboard.user.topShared')" :items="sharedItems" :empty="t('dashboard.user.nothingShared')" bar-class="bg-violet-500/60" />
        <RankList :title="t('dashboard.user.topUsed')" :items="usedItems" :empty="t('dashboard.user.nothingUsed')" bar-class="bg-emerald-500/60" />
      </div>
    </template>
  </section>
</template>
