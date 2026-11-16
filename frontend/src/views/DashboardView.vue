<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import BusinessDashboard from '@/components/dashboard/BusinessDashboard.vue';
import DashboardOverview from '@/components/dashboard/DashboardOverview.vue';
import SecurityDashboard from '@/components/dashboard/SecurityDashboard.vue';
import { useAppBranding } from '@/composables/useAppBranding';
import { useAuthStore } from '@/stores/auth';
import { DASHBOARD_ROLES, hasAnyRole } from '@/utils/roles';
import type { SelectOption } from '@/types/select';

type TabKey = 'overview' | 'security' | 'business';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { resourceSharing } = useAppBranding();

// Each view lists the roles allowed to read it, so a dedicated role can be added later.
const tabs = computed(() => {
  const role = auth.user?.role;
  const list: { key: TabKey; label: string }[] = [{ key: 'overview', label: t('dashboard.tabs.overview') }];
  if (resourceSharing.value && hasAnyRole(role, DASHBOARD_ROLES.security)) {
    list.push({ key: 'security', label: t('dashboard.tabs.security') });
  }
  if (hasAnyRole(role, DASHBOARD_ROLES.business)) {
    list.push({ key: 'business', label: t('dashboard.tabs.business') });
  }
  return list;
});

const requested = ref(typeof route.query.tab === 'string' ? route.query.tab : 'overview');
const active = computed<TabKey>(
  () => tabs.value.find((tab) => tab.key === requested.value)?.key ?? 'overview',
);
const options = computed<SelectOption[]>(() => tabs.value.map((tab) => ({ value: tab.key, label: tab.label })));

function select(key: string) {
  requested.value = key;
  void router.replace({ query: { ...route.query, tab: key } });
}
</script>

<template>
  <AppLayout :title="t('dashboard.title')" :subtitle="t('dashboard.subtitle')">
    <div class="space-y-6">
      <template v-if="tabs.length > 1">
        <div class="sm:hidden">
          <BaseSelect :model-value="active" :options="options" @update:model-value="select" />
        </div>
        <div class="hidden sm:flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 w-fit">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            :class="[
              'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
              active === tab.key
                ? 'bg-primary-600/20 text-primary-300 shadow-sm'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/60',
            ]"
            @click="select(tab.key)"
          >
            {{ tab.label }}
          </button>
        </div>
      </template>

      <DashboardOverview v-if="active === 'overview'" />
      <SecurityDashboard v-else-if="active === 'security'" />
      <BusinessDashboard v-else />
    </div>
  </AppLayout>
</template>
