<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Share2 } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import { listOwnerApplications, type OwnerApplication } from '@/api/resources';
import { useToast } from '@/composables/useToast';
import SharedResourcesPanel from './SharedResourcesPanel.vue';
import GrantsPanel from './GrantsPanel.vue';
import InvitationsPanel from './InvitationsPanel.vue';
import MembersPanel from './MembersPanel.vue';
import UsagePanel from './UsagePanel.vue';
import AccessEventsPanel from './AccessEventsPanel.vue';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();

const tabs = ['resources', 'grants', 'invitations', 'members', 'usage', 'access'] as const;
type Tab = typeof tabs[number];

const ownerApp = ref<OwnerApplication | null>(null);
const loading = ref(true);
const loadError = ref(false);
const activeTab = ref<Tab>('resources');

const canReadResources = computed(
  () => ownerApp.value?.permissions.some((p) => p === 'resources:manage' || p === 'resources:read') ?? false,
);
const canManageGrants = computed(
  () => ownerApp.value?.permissions.includes('grants:manage') ?? false,
);
const visibleTabs = computed<Tab[]>(() =>
  tabs.filter((tab) => {
    if (tab === 'invitations' || tab === 'members' || tab === 'access') {
      return ownerApp.value?.isAdmin === true;
    }
    if (tab === 'grants') return canManageGrants.value;
    return canReadResources.value;
  }),
);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    const res = await listOwnerApplications();
    ownerApp.value = res.apps.find((app) => app.id === props.appId) ?? null;
    if (!visibleTabs.value.includes(activeTab.value)) {
      activeTab.value = visibleTabs.value[0] ?? 'resources';
    }
  } catch (err) {
    loadError.value = true;
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-5">
    <div v-if="loading" class="space-y-3">
      <SkeletonBlock class="h-10 w-80" />
      <SkeletonBlock class="h-48 w-full" />
    </div>

    <EmptyState
      v-else-if="loadError"
      :title="t('share.loadError')"
      :message="t('share.loadErrorHint')"
    >
      <template #action>
        <BaseButton variant="outline" size="sm" @click="load">{{ t('common.retry') }}</BaseButton>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="!ownerApp"
      :title="t('share.noAccessTitle')"
      :message="t('share.noAccessHint')"
    >
      <template #icon><Share2 class="w-8 h-8 text-surface-500" /></template>
    </EmptyState>

    <template v-else>
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

      <SharedResourcesPanel
        v-if="activeTab === 'resources'"
        :app-id="ownerApp.id"
        scope="app"
        :can-manage="ownerApp.permissions.includes('resources:manage')"
        :can-read="canReadResources"
      />
      <GrantsPanel
        v-else-if="activeTab === 'grants'"
        :app-id="ownerApp.id"
        :can-manage="canManageGrants"
        :is-admin="ownerApp.isAdmin"
      />
      <InvitationsPanel
        v-else-if="activeTab === 'invitations'"
        :app-id="ownerApp.id"
      />
      <MembersPanel
        v-else-if="activeTab === 'members'"
        :app-id="ownerApp.id"
      />
      <UsagePanel v-else-if="activeTab === 'usage'" :app-id="ownerApp.id" />
      <AccessEventsPanel v-else :app-id="ownerApp.id" />
    </template>
  </div>
</template>
