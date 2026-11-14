<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import type { ConsumptionAggregate, SubscriptionPlan, SubscriptionPlanPrice, UserApplication } from '@/types';

const props = defineProps<{
  consumption: ConsumptionAggregate[];
  plans: SubscriptionPlan[];
  appUsers: UserApplication[];
}>();

const emit = defineEmits<{ reset: [metric: { userId: string; key: string }] }>();

const { t } = useI18n();

const consumptionUsers = computed(() => {
  const byUser = new Map<string, { userId: string; name: string; email: string | null; image: string | null; subscriptionPlanId: string | null }>();
  for (const entry of props.consumption) {
    if (byUser.has(entry.userId)) continue;
    const pageUser = props.appUsers.find((u) => u.userId === entry.userId);
    byUser.set(entry.userId, {
      userId: entry.userId,
      name: entry.userName ?? pageUser?.name ?? entry.userEmail ?? entry.userId,
      email: entry.userEmail ?? pageUser?.email ?? null,
      image: pageUser?.image ?? null,
      subscriptionPlanId: entry.subscriptionPlanId ?? pageUser?.subscriptionPlanId ?? null,
    });
  }
  return [...byUser.values()];
});

function getPlanName(planId: string | null) {
  return planId ? props.plans.find((p) => p.id === planId)?.name ?? planId : t('common.none');
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** The metered price that bills a feature of a plan, or null. */
function meteredPriceOf(plan: SubscriptionPlan | undefined, key: string): SubscriptionPlanPrice | null {
  return plan?.prices.find((p) => p.billingType === 'metered' && p.featureKey === key) ?? null;
}

/** Share of a metered feature's cap already used, with its colour; null when uncapped. */
function usageOf(plan: SubscriptionPlan | undefined, key: string, total: string): { ratio: number; cls: string; price: SubscriptionPlanPrice } | null {
  const price = meteredPriceOf(plan, key);
  if (!price || price.usageLimit === null || price.usageLimit < 0) return null;
  const used = Number(total);
  const ratio = price.usageLimit === 0 ? (used > 0 ? 1 : 0) : used / price.usageLimit;
  const cls = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-primary-500';
  return { ratio, cls, price };
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="!consumption.length" class="text-center text-sm text-surface-500 py-8">{{ t('appDetail.noConsumption') }}</div>
    <template v-else>
      <div v-for="ua in consumptionUsers" :key="ua.userId" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-3 border-b border-surface-700/40 flex items-center gap-3 bg-surface-800/30">
          <UserAvatar :name="ua.name" :image="ua.image" size="xs" />
          <span class="text-sm font-medium text-surface-200">{{ ua.name }}</span>
          <BaseBadge v-if="ua.subscriptionPlanId" variant="primary" size="sm">{{ getPlanName(ua.subscriptionPlanId) }}</BaseBadge>
        </div>
        <div class="divide-y divide-surface-800/40">
          <div v-for="agg in consumption.filter(c => c.userId === ua.userId)" :key="agg.key" class="px-5 py-3">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-2">
                <code class="text-xs font-mono text-surface-400 bg-surface-800/50 px-1.5 py-0.5 rounded">{{ agg.key }}</code>
                <template v-if="ua.subscriptionPlanId">
                  <template v-for="plan in plans.filter(p => p.id === ua.subscriptionPlanId)" :key="plan.id">
                    <template v-if="meteredPriceOf(plan, agg.key)">
                      <span class="text-xs text-surface-500">{{ meteredPriceOf(plan, agg.key)?.unit }}</span>
                      <BaseBadge variant="warning" size="sm">{{ t('appDetail.metered') }}</BaseBadge>
                    </template>
                  </template>
                </template>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-sm font-semibold text-surface-100 tabular-nums">{{ Number(agg.total).toLocaleString() }}</span>
                <span class="text-xs text-surface-500">{{ formatDate(agg.updatedAt) }}</span>
                <button @click="emit('reset', { userId: agg.userId, key: agg.key })" class="text-xs text-red-500 hover:text-red-400 transition-colors">{{ t('appDetail.resetMetric') }}</button>
              </div>
            </div>
            <template v-if="ua.subscriptionPlanId">
              <template v-for="plan in plans.filter(p => p.id === ua.subscriptionPlanId)" :key="plan.id">
                <template v-if="usageOf(plan, agg.key, agg.total)">
                  <div class="h-1.5 rounded-full bg-surface-800 overflow-hidden">
                    <div
                      :class="['h-full rounded-full transition-all', usageOf(plan, agg.key, agg.total)?.cls]"
                      :style="{ width: Math.min(100, (usageOf(plan, agg.key, agg.total)?.ratio ?? 0) * 100) + '%' }"
                    />
                  </div>
                  <div class="flex justify-between text-xs text-surface-500 mt-0.5">
                    <span>{{ Number(agg.total).toLocaleString() }} / {{ usageOf(plan, agg.key, agg.total)?.price.usageLimit?.toLocaleString() }} {{ usageOf(plan, agg.key, agg.total)?.price.unit }}</span>
                    <span>{{ Math.round((usageOf(plan, agg.key, agg.total)?.ratio ?? 0) * 100) }}%</span>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
