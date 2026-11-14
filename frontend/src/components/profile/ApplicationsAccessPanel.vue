<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { CreditCard, ExternalLink } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import type { ConsumptionAggregate, UserSubscriptionEntry } from '@/types';

defineProps<{
  subscriptions: UserSubscriptionEntry[];
  consumption: Record<string, ConsumptionAggregate[]>;
  loading: boolean;
  stripeConfigured: boolean;
}>();

const emit = defineEmits<{
  changePlan: [subscription: UserSubscriptionEntry];
}>();

const { t } = useI18n();

/** Only http(s) application URLs are rendered as links (never javascript:). */
function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
</script>

<template>
  <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
    <div class="px-5 py-4 border-b border-surface-700/40">
      <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.appAccess') }}</h3>
    </div>
    <div v-if="loading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
    <div v-else-if="!subscriptions.length" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.noData') }}</div>
    <div v-else class="divide-y divide-surface-800/40">
      <div v-for="sub in subscriptions" :key="sub.applicationId" class="px-4 py-4 sm:px-5">
        <div class="flex flex-wrap items-center gap-2 mb-2 sm:gap-3">
          <div class="flex items-center gap-2 min-w-0 w-full sm:flex-1">
            <img v-if="sub.applicationIcon" :src="sub.applicationIcon" class="w-5 h-5 rounded shrink-0" />
            <a
              v-if="isHttpUrl(sub.applicationUrl)"
              :href="sub.applicationUrl || undefined"
              target="_blank"
              rel="noopener noreferrer"
              class="group inline-flex items-center gap-1.5 min-w-0 flex-1 text-sm font-medium text-surface-200 hover:text-primary-300 transition-colors"
              :title="sub.applicationUrl || undefined"
            >
              <span class="truncate">{{ sub.applicationName }}</span>
              <ExternalLink class="w-3.5 h-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
            </a>
            <p v-else class="text-sm font-medium text-surface-200 flex-1 truncate">{{ sub.applicationName }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <BaseBadge :variant="sub.isActive ? 'success' : 'neutral'" size="sm" dot>{{ sub.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
            <BaseBadge v-if="sub.plan" variant="neutral" size="sm">{{ sub.plan.name }}</BaseBadge>
            <BaseButton
              v-if="stripeConfigured && sub.availablePlans.length > 0"
              size="sm"
              variant="outline"
              @click="emit('changePlan', sub)"
            >
              <CreditCard class="w-3.5 h-3.5" />{{ t('profile.changePlan') }}
            </BaseButton>
          </div>
        </div>
        <p v-if="!stripeConfigured && sub.availablePlans.length > 0" class="text-xs text-surface-500">{{ t('profile.manageByAdmin') }}</p>
        <div v-if="consumption[sub.applicationId]?.length" class="flex flex-wrap gap-2 mt-2">
          <div v-for="agg in consumption[sub.applicationId]" :key="agg.key" class="px-2.5 py-1 rounded-lg bg-surface-800/60 border border-surface-700/30">
            <span class="text-xs font-mono text-surface-500">{{ agg.key }}: </span>
            <span class="text-xs font-semibold text-surface-200">{{ Number(agg.total).toLocaleString() }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
