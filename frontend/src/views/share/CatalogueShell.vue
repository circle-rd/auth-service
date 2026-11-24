<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { BookOpen, Share2 } from '@lucide/vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import CatalogueSidebar from '@/components/layout/CatalogueSidebar.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import { useCatalogueStore } from '@/stores/catalogue';
import { useRealtimeEvents } from '@/composables/useRealtimeEvents';
import { provideCatalogueActivity } from '@/composables/useCatalogueActivity';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useCatalogueStore();

const appId = computed(() => (typeof route.params.appId === 'string' ? route.params.appId : null));
const app = computed(() => (appId.value ? store.byId.get(appId.value) ?? null : null));
const overview = computed(() => (appId.value ? store.overviews[appId.value] ?? null : null));

const section = computed(() => {
  if (route.name === 'catalogue-manage') return t('share.catalogue.nav.manage');
  if (route.name === 'catalogue-type') {
    const scheme = overview.value?.schemes.find((entry) => entry.scheme === route.params.scheme);
    return scheme?.displayName ?? t('share.catalogue.nav.types');
  }
  return t('share.catalogue.nav.dashboard');
});

function sync() {
  if (!store.appsLoaded) return;
  if (!appId.value) {
    const target = store.defaultAppId();
    if (target) void router.replace({ name: 'catalogue-dashboard', params: { appId: target } });
    return;
  }
  if (!store.byId.has(appId.value)) return;
  store.rememberApp(appId.value);
  void store.loadOverview(appId.value);
}

watch(() => [store.appsLoaded, appId.value], sync);
void store.loadApps().then(sync);

// A resource type that was deactivated while the page is open leaves the overview.
watch(overview, (current) => {
  if (route.name !== 'catalogue-type' || !current || !appId.value) return;
  if (!current.schemes.some((entry) => entry.scheme === route.params.scheme)) {
    void router.replace({ name: 'catalogue-dashboard', params: { appId: appId.value } });
  }
});

// Resource types, shares and grants change outside this tab (an administrator
// enabling a scheme, another user sharing a resource). The server only addresses
// the frames this session may see; the overview is re-read on each of them.
function refreshOverview() {
  if (appId.value && store.byId.has(appId.value)) {
    void store.loadOverview(appId.value, true);
  }
}

// Role and owner delegation are read once per application list: after a
// reconnection they are re-read, so a lost right disappears from the sidebar.
function refreshCatalogue() {
  void store.loadApps(true).then(() => {
    sync();
    refreshOverview();
  });
}

const activityTick = provideCatalogueActivity();
function refreshActivity() {
  activityTick.value += 1;
}

const events = useRealtimeEvents(
  {
    'catalogue.changed': refreshOverview,
    'resource.changed': refreshOverview,
    'resource.activity': refreshActivity,
  },
  {
    onResync: () => {
      refreshCatalogue();
      refreshActivity();
    },
  },
);
onBeforeUnmount(() => events.close());

</script>

<template>
  <AppLayout :title="section" :subtitle="app?.name">
    <template #sidebar>
      <CatalogueSidebar :app-id="appId" />
    </template>

    <div data-testid="subject-catalogue">
      <div v-if="!store.appsLoaded && !store.appsError" class="space-y-3">
        <SkeletonBlock class="h-24 w-full" />
        <SkeletonBlock class="h-40 w-full" />
      </div>

      <EmptyState
        v-else-if="store.appsError"
        :title="t('share.loadError')"
        :message="t('share.loadErrorHint')"
      >
        <template #action>
          <BaseButton variant="outline" size="sm" @click="store.loadApps(true).then(sync)">{{ t('common.retry') }}</BaseButton>
        </template>
      </EmptyState>

      <EmptyState
        v-else-if="store.apps.length === 0"
        :title="t('share.catalogue.empty')"
        :message="t('share.catalogue.emptyHint')"
      >
        <template #icon><BookOpen class="w-8 h-8 text-surface-500" /></template>
      </EmptyState>

      <EmptyState
        v-else-if="appId && !app"
        :title="t('share.noAccessTitle')"
        :message="t('share.noAccessHint')"
      >
        <template #icon><Share2 class="w-8 h-8 text-surface-500" /></template>
      </EmptyState>

      <RouterView v-else-if="app" v-slot="{ Component }">
        <component :is="Component" :key="app.id" />
      </RouterView>
    </div>
  </AppLayout>
</template>
