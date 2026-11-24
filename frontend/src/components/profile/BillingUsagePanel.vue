<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Gauge } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ApplicationIcon from '@/components/applications/ApplicationIcon.vue';
import { getMyUsage } from '@/api/billing';
import type { BillingUsage, UserSubscriptionEntry } from '@/types';

const props = defineProps<{
  subscriptions: UserSubscriptionEntry[];
}>();

const { t, locale } = useI18n();
const usage = ref<Record<string, BillingUsage>>({});
const failed = ref<Set<string>>(new Set());
const pending = ref<Set<string>>(new Set());

const withPlan = computed(() => props.subscriptions.filter((s) => s.plan));

async function loadUsage(): Promise<void> {
  for (const sub of withPlan.value) {
    const id = sub.applicationId;
    if (id in usage.value || failed.value.has(id) || pending.value.has(id)) continue;
    pending.value.add(id);
    try {
      usage.value[id] = await getMyUsage(id);
    } catch (err) {
      failed.value.add(id);
      console.error('billing usage could not be loaded', err);
    } finally {
      pending.value.delete(id);
    }
  }
}

function retry(id: string): void {
  failed.value.delete(id);
  void loadUsage();
}

watch(withPlan, () => void loadUsage());
onMounted(() => void loadUsage());

function share(used: number, limit: number): number {
  return Math.min(100, Math.round((used / limit) * 100));
}
</script>

<template>
  <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
    <header class="px-5 py-4 border-b border-surface-700/40 flex items-center gap-2">
      <Gauge class="w-4 h-4 text-surface-400" />
      <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.billingPanel.usageTitle') }}</h3>
    </header>
    <div v-if="!withPlan.length" class="px-5 py-8 text-center text-sm text-surface-500">
      {{ t('profile.billingPanel.noMetered') }}
    </div>
    <div v-else class="divide-y divide-surface-800/40">
      <div v-for="sub in withPlan" :key="sub.applicationId" class="px-5 py-4">
        <div class="flex items-center gap-3 mb-3">
          <ApplicationIcon :name="sub.applicationName" :icon="sub.applicationIcon" />
          <p class="text-sm font-medium text-surface-200 flex-1 truncate">{{ sub.applicationName }}</p>
          <BaseBadge variant="neutral" size="sm">{{ sub.plan!.name }}</BaseBadge>
        </div>
        <div v-if="failed.has(sub.applicationId)" class="flex items-center gap-3 text-xs text-surface-500">
          <span>{{ t('profile.billingPanel.usageUnavailable') }}</span>
          <BaseButton variant="ghost" size="sm" @click="retry(sub.applicationId)">{{ t('common.retry') }}</BaseButton>
        </div>
        <p v-else-if="pending.has(sub.applicationId) || !usage[sub.applicationId]" class="text-xs text-surface-500">{{ t('common.loading') }}</p>
        <p v-else-if="usage[sub.applicationId]!.features.length === 0" class="text-xs text-surface-500">
          {{ t('profile.billingPanel.noMetered') }}
        </p>
        <ul v-else class="space-y-3">
          <li v-for="f in usage[sub.applicationId]!.features" :key="f.featureKey">
            <div class="flex items-baseline justify-between text-sm">
              <code class="text-xs font-mono text-surface-500">{{ f.featureKey }}</code>
              <span class="tabular-nums text-surface-200">
                {{ f.used.toLocaleString(locale) }}
                <template v-if="f.usageLimit >= 0"> / {{ f.usageLimit.toLocaleString(locale) }}</template>
                <span class="text-surface-500"> {{ f.unit ?? '' }}</span>
              </span>
            </div>
            <div v-if="f.usageLimit > 0" class="mt-1.5 h-1.5 rounded-full bg-surface-800 overflow-hidden" role="progressbar" :aria-valuenow="share(f.used, f.usageLimit)" aria-valuemin="0" aria-valuemax="100">
              <div class="h-full rounded-full bg-primary-500" :style="{ width: `${share(f.used, f.usageLimit)}%` }" />
            </div>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
