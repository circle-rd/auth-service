<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Activity, Coins, ShieldAlert, Share2 } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import StatCard from '@/components/ui/StatCard.vue';
import { getUserActivity, type MonitoringRange, type UserActivity } from '@/api/monitoring';
import { formatDateTime } from '@/views/share/format';
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

watch([() => props.appId, range], () => void load(), { immediate: true });

const usedSeries = computed(() => (activity.value?.used.series ?? []).map((point) => ({ date: point.date, allow: point.calls })));

const accessorItems = computed<RankItem[]>(() =>
  (activity.value?.shared.topSubjects ?? []).map((entry) => ({
    key: entry.subjectId,
    label: entry.name ?? entry.subjectId,
    sub: t('dashboard.user.lastAccess', { date: formatDateTime(entry.lastAt) }),
    value: entry.calls,
  })),
);
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
        <StatCard :label="t('dashboard.user.reached')" :value="activity?.shared.allow ?? ''" :loading="!activity" :icon="Share2" />
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

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <RankList :title="t('dashboard.user.topAccessors')" :items="accessorItems" :empty="t('dashboard.user.nothingShared')" />
        <RankList :title="t('dashboard.user.topShared')" :items="sharedItems" :empty="t('dashboard.user.nothingShared')" bar-class="bg-violet-500/60" />
        <RankList :title="t('dashboard.user.topUsed')" :items="usedItems" :empty="t('dashboard.user.nothingUsed')" bar-class="bg-emerald-500/60" />
      </div>

      <div v-if="activity && activity.shared.recent.length > 0" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-3">{{ t('dashboard.user.recent') }}</h3>
        <ul class="divide-y divide-surface-800/60">
          <li v-for="(entry, index) in activity.shared.recent" :key="index" class="flex items-center gap-3 py-2.5">
            <BaseBadge :variant="entry.decision === 'allow' ? 'success' : 'error'" dot>
              {{ t(`share.access.decisions.${entry.decision}`) }}
            </BaseBadge>
            <div class="min-w-0 flex-1">
              <p class="text-sm text-surface-200 truncate">{{ entry.subjectName ?? t('dashboard.security.log.unknownSubject') }}</p>
              <p class="font-mono text-[11px] text-surface-500 truncate">{{ entry.uri }}</p>
            </div>
            <span class="text-xs text-surface-500 shrink-0">{{ formatDateTime(entry.occurredAt) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
