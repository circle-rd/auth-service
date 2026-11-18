<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Boxes, Download, KeyRound, ShieldAlert, ShieldCheck, TriangleAlert } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import StatCard from '@/components/ui/StatCard.vue';
import { downloadText, neutralizeFormula, toCsv } from '@/utils/csv';
import {
  getSecurityStats,
  listAdminAccessEvents,
  type AdminAccessEvent,
  type MonitoringRange,
  type SecurityStats,
} from '@/api/monitoring';
import DecisionChart from './DecisionChart.vue';
import RankList, { type RankItem } from './RankList.vue';
import { formatDateTime } from '@/views/share/format';

const PAGE = 25;

const { t } = useI18n();

const range = ref<MonitoringRange>('7d');
const stats = ref<SecurityStats | null>(null);
const failed = ref(false);

const events = ref<AdminAccessEvent[]>([]);
const decision = ref<'' | 'allow' | 'deny'>('');
const nextOffset = ref<number | null>(null);
const eventsLoading = ref(false);

const decisionOptions = computed(() => [
  { value: '', label: t('dashboard.security.log.all') },
  { value: 'allow', label: t('share.access.decisions.allow') },
  { value: 'deny', label: t('share.access.decisions.deny') },
]);

async function loadStats() {
  failed.value = false;
  stats.value = null;
  try {
    stats.value = await getSecurityStats(range.value);
  } catch {
    failed.value = true;
  }
}

async function loadEvents(append: boolean) {
  eventsLoading.value = true;
  try {
    const page = await listAdminAccessEvents({
      decision: decision.value || undefined,
      limit: PAGE,
      offset: append ? nextOffset.value ?? 0 : 0,
    });
    events.value = append ? [...events.value, ...page.events] : page.events;
    nextOffset.value = page.nextOffset;
  } finally {
    eventsLoading.value = false;
  }
}

function setDecision(value: string) {
  decision.value = value === 'allow' || value === 'deny' ? value : '';
}

watch(range, () => void loadStats());
watch(decision, () => void loadEvents(false));
onMounted(() => {
  void loadStats();
  void loadEvents(false);
});

const denyRate = computed(() => {
  const access = stats.value?.access;
  const total = (access?.allow ?? 0) + (access?.deny ?? 0);
  return total === 0 ? 0 : Math.round(((access?.deny ?? 0) / total) * 100);
});

const pendingResources = computed(
  () => stats.value?.resources.byStatus
    .filter((entry) => entry.status === 'pending_validation' || entry.status === 'validation_failed')
    .reduce((acc, entry) => acc + entry.count, 0) ?? 0,
);

function subjectLabel(name: string | null, email: string | null, id: string | null): string {
  return name ?? email ?? id ?? t('dashboard.security.log.unknownSubject');
}

const statusItems = computed<RankItem[]>(() =>
  (stats.value?.resources.byStatus ?? []).map((entry) => ({
    key: entry.status,
    label: t(`share.resourceStatuses.${entry.status}`),
    value: entry.count,
  })),
);
const schemeItems = computed<RankItem[]>(() =>
  (stats.value?.resources.byScheme ?? []).map((entry) => ({
    key: entry.scheme,
    label: entry.scheme,
    value: entry.count,
  })),
);
const grantItems = computed<RankItem[]>(() =>
  (stats.value?.grants.bySubjectType ?? []).map((entry) => ({
    key: entry.subjectType,
    label: t(`share.subjectTypes.${entry.subjectType}`),
    value: entry.count,
  })),
);
const reasonItems = computed<RankItem[]>(() =>
  (stats.value?.access.topDeniedReasons ?? []).map((entry) => ({
    key: entry.reason,
    label: entry.reason,
    value: entry.count,
  })),
);
const resourceItems = computed<RankItem[]>(() =>
  (stats.value?.access.topResources ?? []).map((entry) => ({
    key: entry.uri,
    label: entry.uri,
    value: entry.calls,
    note: entry.denies > 0 ? t('dashboard.security.deniedCount', { count: entry.denies }) : undefined,
  })),
);
const subjectItems = computed<RankItem[]>(() =>
  (stats.value?.access.topSubjects ?? []).map((entry) => ({
    key: entry.subjectId,
    label: subjectLabel(entry.name, entry.email, entry.subjectId),
    sub: entry.email ?? undefined,
    value: entry.calls,
    note: entry.denies > 0 ? t('dashboard.security.deniedCount', { count: entry.denies }) : undefined,
  })),
);

function exportCsv() {
  const header = ['occurredAt', 'decision', 'uri', 'subject', 'client', 'source', 'reason'];
  const rows = events.value.map((event) => [
    event.occurredAt,
    event.decision,
    event.uri,
    subjectLabel(event.subjectName, event.subjectEmail, event.subjectId),
    event.clientId,
    event.source,
    event.reasonClass ?? '',
  ].map(neutralizeFormula));
  downloadText('resource-access-events.csv', toCsv([header, ...rows]));
}
</script>

<template>
  <div class="space-y-6" data-testid="security-dashboard">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <p class="text-sm text-surface-400">{{ t('dashboard.security.hint') }}</p>
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

    <div v-if="failed" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20 text-amber-300">
      <TriangleAlert class="w-4 h-4 mt-0.5 shrink-0" />
      <p class="text-sm">{{ t('dashboard.security.unavailable') }}</p>
    </div>

    <template v-else>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          :label="t('dashboard.security.decisions')"
          :value="stats ? stats.access.allow + stats.access.deny : ''"
          :loading="!stats"
          :icon="ShieldCheck"
          :sub="stats ? t('dashboard.security.allowedCount', { count: stats.access.allow }) : ''"
        />
        <StatCard
          :label="t('dashboard.security.denyRate')"
          :value="stats ? `${denyRate} %` : ''"
          :loading="!stats"
          :icon="ShieldAlert"
          :sub="stats ? t('dashboard.security.deniedCount', { count: stats.access.deny }) : ''"
        />
        <StatCard
          :label="t('dashboard.security.activeGrants')"
          :value="stats ? stats.grants.active : ''"
          :loading="!stats"
          :icon="KeyRound"
          :sub="stats ? t('dashboard.security.expiringSoon', { count: stats.grants.expiringSoon }) : ''"
        />
        <StatCard
          :label="t('dashboard.security.resources')"
          :value="stats ? stats.resources.total : ''"
          :loading="!stats"
          :icon="Boxes"
          :sub="stats ? t('dashboard.security.pendingInvitations', { count: stats.invitations.pending }) : ''"
        />
      </div>

      <div v-if="stats && (stats.grants.everyone > 0 || pendingResources > 0)" class="space-y-2">
        <div v-if="stats.grants.everyone > 0" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20 text-amber-300">
          <TriangleAlert class="w-4 h-4 mt-0.5 shrink-0" />
          <p class="text-sm">{{ t('dashboard.security.everyoneWarning', { count: stats.grants.everyone }) }}</p>
        </div>
        <div v-if="pendingResources > 0" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-sky-500/8 border border-sky-500/20 text-sky-300">
          <Boxes class="w-4 h-4 mt-0.5 shrink-0" />
          <p class="text-sm">{{ t('dashboard.security.pendingResources', { count: pendingResources }) }}</p>
        </div>
      </div>

      <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <h3 class="text-sm font-semibold text-surface-200 mb-4">{{ t('dashboard.security.chart') }}</h3>
        <DecisionChart
          :series="stats?.access.series ?? []"
          :allow-label="t('share.access.decisions.allow')"
          :deny-label="t('share.access.decisions.deny')"
          :loading="!stats"
        >
          <template #empty>{{ t('dashboard.security.noActivity') }}</template>
        </DecisionChart>
      </section>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <RankList :title="t('dashboard.security.topResources')" :items="resourceItems" :empty="t('dashboard.security.noActivity')" />
        <RankList :title="t('dashboard.security.topSubjects')" :items="subjectItems" :empty="t('dashboard.security.noActivity')" />
        <RankList :title="t('dashboard.security.deniedReasons')" :items="reasonItems" :empty="t('dashboard.security.noDenials')" bar-class="bg-rose-500/60" />
        <RankList :title="t('dashboard.security.byStatus')" :items="statusItems" :empty="t('share.resources.empty')" bar-class="bg-emerald-500/60" />
        <RankList :title="t('dashboard.security.byType')" :items="schemeItems" :empty="t('share.resources.empty')" bar-class="bg-sky-500/60" />
        <RankList :title="t('dashboard.security.grantsBySubject')" :items="grantItems" :empty="t('share.grants.empty')" bar-class="bg-violet-500/60" />
      </div>
    </template>

    <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden" data-testid="activity-log">
      <div class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between gap-3 flex-wrap">
        <h3 class="text-sm font-semibold text-surface-200">{{ t('dashboard.security.log.title') }}</h3>
        <div class="flex items-center gap-2">
          <BaseSelect :model-value="decision" :options="decisionOptions" size="sm" class="w-40" @update:model-value="setDecision" />
          <BaseButton variant="outline" size="sm" :disabled="events.length === 0" @click="exportCsv">
            <Download class="w-3.5 h-3.5" />{{ t('dashboard.security.log.export') }}
          </BaseButton>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface-800/50 text-surface-400">
            <tr>
              <th class="text-left font-medium px-4 py-2.5">{{ t('share.access.time') }}</th>
              <th class="text-left font-medium px-4 py-2.5">{{ t('share.access.decision') }}</th>
              <th class="text-left font-medium px-4 py-2.5">{{ t('share.access.resource') }}</th>
              <th class="text-left font-medium px-4 py-2.5 hidden md:table-cell">{{ t('share.access.subject') }}</th>
              <th class="text-left font-medium px-4 py-2.5 hidden lg:table-cell">{{ t('share.access.reason') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id" class="border-t border-surface-800/60">
              <td class="px-4 py-2.5 text-xs text-surface-500 whitespace-nowrap">{{ formatDateTime(event.occurredAt) }}</td>
              <td class="px-4 py-2.5">
                <BaseBadge :variant="event.decision === 'allow' ? 'success' : 'error'" dot>
                  {{ t(`share.access.decisions.${event.decision}`) }}
                </BaseBadge>
              </td>
              <td class="px-4 py-2.5 font-mono text-xs text-surface-300 break-all">{{ event.uri }}</td>
              <td class="px-4 py-2.5 text-surface-300 hidden md:table-cell">
                {{ subjectLabel(event.subjectName, event.subjectEmail, event.subjectId) }}
              </td>
              <td class="px-4 py-2.5 text-xs text-surface-500 hidden lg:table-cell">{{ event.reasonClass ?? '—' }}</td>
            </tr>
            <tr v-if="events.length === 0 && !eventsLoading">
              <td colspan="5" class="px-4 py-8 text-center text-sm text-surface-500">{{ t('share.access.empty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="nextOffset !== null" class="px-5 py-3 border-t border-surface-800/60 flex justify-center">
        <BaseButton variant="ghost" size="sm" :loading="eventsLoading" @click="loadEvents(true)">
          {{ t('dashboard.security.log.more') }}
        </BaseButton>
      </div>
    </section>
  </div>
</template>
