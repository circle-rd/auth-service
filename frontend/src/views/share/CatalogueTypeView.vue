<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import { useCatalogueStore } from '@/stores/catalogue';
import AccessibleResourceList from './AccessibleResourceList.vue';
import SharedResourcesPanel from './SharedResourcesPanel.vue';
import SshKeysPanel from './SshKeysPanel.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useCatalogueStore();

const appId = computed(() => String(route.params.appId));
const schemeName = computed(() => String(route.params.scheme));
const overview = computed(() => store.overviews[appId.value] ?? null);
const scheme = computed(
  () => overview.value?.schemes.find((entry) => entry.scheme === schemeName.value) ?? null,
);
const mine = computed(
  () => overview.value?.mine.filter((resource) => resource.scheme === schemeName.value) ?? [],
);
const shared = computed(
  () => overview.value?.accessible.filter(
    (resource) => resource.scheme === schemeName.value && resource.accessKind !== 'owner',
  ) ?? [],
);

// A type that is not enabled for this application has no page.
watch(
  [overview, scheme],
  () => {
    if (overview.value && !scheme.value) {
      void router.replace({ name: 'catalogue-dashboard', params: { appId: appId.value } });
    }
  },
  { immediate: true },
);

function refresh() {
  void store.loadOverview(appId.value, true);
}
</script>

<template>
  <div v-if="!scheme" class="space-y-3">
    <SkeletonBlock class="h-28 w-full" />
    <SkeletonBlock class="h-40 w-full" />
  </div>

  <div v-else class="space-y-8" :data-testid="`catalogue-type-${scheme.scheme}`">
    <header class="flex items-center gap-4 rounded-2xl border border-surface-700/40 bg-surface-900/40 p-5">
      <SchemeIcon :icon="scheme.icon" :scheme="scheme.scheme" size="lg" />
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold text-surface-100 truncate">{{ scheme.displayName }}</h2>
        <p class="font-mono text-xs text-surface-500">{{ scheme.scheme }}://</p>
        <p v-if="scheme.description" class="text-sm text-surface-400 mt-1">{{ scheme.description }}</p>
      </div>
      <div class="hidden sm:flex flex-col items-end gap-1.5 shrink-0">
        <BaseBadge variant="primary">{{ t('share.catalogue.dashboard.mineCount', { count: mine.length }) }}</BaseBadge>
        <BaseBadge variant="neutral">{{ t('share.catalogue.dashboard.sharedCount', { count: shared.length }) }}</BaseBadge>
      </div>
    </header>

    <SshKeysPanel v-if="scheme.scheme === 'ssh'" />

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-surface-200">{{ t('share.catalogue.type.created') }}</h2>
      <SharedResourcesPanel
        :app-id="appId"
        scope="mine"
        :scheme="scheme.scheme"
        can-manage
        can-read
        @changed="refresh"
      />
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-surface-200">{{ t('share.catalogue.type.shared') }}</h2>
      <AccessibleResourceList :resources="shared" :icon="scheme.icon" />
    </section>
  </div>
</template>
