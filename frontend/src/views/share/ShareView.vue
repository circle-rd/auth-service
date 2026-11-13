<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Share2 } from '@lucide/vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import { listOwnerApplications, type OwnerApplication } from '@/api/resources';
import { useToast } from '@/composables/useToast';
import type { SelectOption } from '@/types/select';
import SharedResourcesPanel from './SharedResourcesPanel.vue';
import GrantsPanel from './GrantsPanel.vue';
import InvitationsPanel from './InvitationsPanel.vue';
import MembersPanel from './MembersPanel.vue';
import UsagePanel from './UsagePanel.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();

const tabs = ['resources', 'grants', 'invitations', 'members', 'usage'] as const;
type Tab = typeof tabs[number];

const apps = ref<OwnerApplication[]>([]);
const loading = ref(true);
const selectedAppId = ref(typeof route.query.app === 'string' ? route.query.app : '');
const activeTab = ref<Tab>(
  tabs.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'resources',
);

const appOptions = computed<SelectOption[]>(() =>
  apps.value.map((app) => ({ value: app.id, label: app.name })),
);

const selectedApp = computed(() => apps.value.find((app) => app.id === selectedAppId.value) ?? null);
const canReadResources = computed(
  () => selectedApp.value?.permissions.some((p) => p === 'resources:manage' || p === 'resources:read') ?? false,
);
const canManageGrants = computed(() => selectedApp.value?.permissions.includes('grants:manage') ?? false);
const visibleTabs = computed<Tab[]>(() =>
  tabs.filter((tab) => {
    if (tab === 'grants' || tab === 'invitations') return canManageGrants.value;
    return canReadResources.value;
  }),
);


function syncQuery() {
  void router.replace({
    query: {
      ...route.query,
      app: selectedAppId.value || undefined,
      tab: activeTab.value,
    },
  });
}

watch(selectedAppId, (value) => {
  if (value) syncQuery();
  if (!visibleTabs.value.includes(activeTab.value)) {
    activeTab.value = visibleTabs.value[0] ?? 'resources';
  }
});

watch(activeTab, () => syncQuery());

onMounted(async () => {
  try {
    const res = await listOwnerApplications();
    apps.value = res.apps;
    if (!apps.value.some((app) => app.id === selectedAppId.value)) {
      selectedAppId.value = apps.value[0]?.id ?? '';
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <AppLayout :title="t('share.title')" :subtitle="t('share.subtitle')">
    <div class="space-y-5">
      <div v-if="loading" class="space-y-3">
        <SkeletonBlock class="h-10 w-80" />
        <SkeletonBlock class="h-48 w-full" />
      </div>

      <EmptyState
        v-else-if="apps.length === 0"
        :title="t('share.noApps')"
        :message="t('share.noAppsHint')"
      >
        <template #icon><Share2 class="w-8 h-8 text-surface-500" /></template>
      </EmptyState>

      <template v-else>
        <div class="flex flex-wrap items-end gap-3">
          <BaseSelect
            v-model="selectedAppId"
            :label="t('share.application')"
            :options="appOptions"
            class="w-72"
          />
          <div v-if="selectedApp" class="flex flex-wrap gap-1.5 pb-2">
            <BaseBadge v-for="permission in selectedApp.permissions" :key="permission" variant="neutral">
              {{ permission }}
            </BaseBadge>
          </div>
        </div>

        <div class="flex flex-wrap gap-1 border-b border-surface-700/50">
          <button
            v-for="tab in visibleTabs"
            :key="tab"
            type="button"
            class="px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors"
            :class="activeTab === tab
              ? 'border-primary-500 text-primary-300'
              : 'border-transparent text-surface-400 hover:text-surface-200'"
            @click="activeTab = tab"
          >
            {{ t(`share.tabs.${tab}`) }}
          </button>
        </div>

        <template v-if="selectedApp">
          <SharedResourcesPanel
            v-if="activeTab === 'resources'"
            :app-id="selectedApp.id"
            :can-manage="selectedApp.permissions.includes('resources:manage')"
            :can-read="canReadResources"
          />
          <GrantsPanel
            v-else-if="activeTab === 'grants'"
            :app-id="selectedApp.id"
            :can-manage="canManageGrants"
          />
          <InvitationsPanel
            v-else-if="activeTab === 'invitations'"
            :app-id="selectedApp.id"
            :can-manage="canManageGrants"
          />
          <MembersPanel v-else-if="activeTab === 'members'" :app-id="selectedApp.id" />
          <UsagePanel v-else :app-id="selectedApp.id" />
        </template>
      </template>
    </div>
  </AppLayout>
</template>
