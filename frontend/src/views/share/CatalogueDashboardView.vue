<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { CircleCheck, Clock, Share2, Boxes } from '@lucide/vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import StatCard from '@/components/ui/StatCard.vue';
import { useCatalogueStore } from '@/stores/catalogue';

const { t } = useI18n();
const route = useRoute();
const store = useCatalogueStore();

const appId = computed(() => String(route.params.appId));
const overview = computed(() => store.overviews[appId.value] ?? null);

const sharedWithMe = computed(
  () => overview.value?.accessible.filter((resource) => resource.accessKind !== 'owner') ?? [],
);
const pending = computed(
  () => overview.value?.mine.filter((resource) => resource.status !== 'validated' && resource.status !== 'disabled') ?? [],
);

const byType = computed(() =>
  (overview.value?.schemes ?? []).map((scheme) => ({
    scheme,
    mine: overview.value?.mine.filter((resource) => resource.scheme === scheme.scheme).length ?? 0,
    shared: sharedWithMe.value.filter((resource) => resource.scheme === scheme.scheme).length,
  })),
);
</script>

<template>
  <div v-if="!overview" class="space-y-3">
    <SkeletonBlock class="h-28 w-full" />
    <SkeletonBlock class="h-40 w-full" />
  </div>

  <div v-else class="space-y-6" data-testid="catalogue-dashboard">
    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <StatCard :label="t('share.catalogue.dashboard.myResources')" :value="overview.mine.length" :icon="Boxes" />
      <StatCard :label="t('share.catalogue.dashboard.sharedWithMe')" :value="sharedWithMe.length" :icon="Share2" />
      <StatCard :label="t('share.catalogue.dashboard.validated')" :value="overview.mine.filter((r) => r.status === 'validated').length" :icon="CircleCheck" />
      <StatCard :label="t('share.catalogue.dashboard.pending')" :value="pending.length" :icon="Clock" />
    </div>

    <section class="rounded-2xl border border-surface-700/40 bg-surface-900/40 p-4 sm:p-5 space-y-3">
      <h2 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">
        {{ t('share.catalogue.dashboard.byType') }}
      </h2>
      <p v-if="byType.length === 0" class="text-sm text-surface-500">{{ t('share.schemes.empty') }}</p>
      <ul v-else class="divide-y divide-surface-800/60">
        <li v-for="entry in byType" :key="entry.scheme.scheme">
          <RouterLink
            :to="{ name: 'catalogue-type', params: { appId, scheme: entry.scheme.scheme } }"
            class="flex items-center gap-4 py-3 rounded-lg hover:bg-surface-800/40 transition-colors px-2 -mx-2"
          >
            <SchemeIcon :icon="entry.scheme.icon" :scheme="entry.scheme.scheme" />
            <div class="min-w-0 flex-1">
              <p class="font-medium text-surface-100 truncate">{{ entry.scheme.displayName }}</p>
              <p class="text-xs text-surface-500 truncate">{{ entry.scheme.description }}</p>
            </div>
            <div class="text-right text-xs text-surface-400 tabular-nums shrink-0">
              <p>{{ t('share.catalogue.dashboard.mineCount', { count: entry.mine }) }}</p>
              <p>{{ t('share.catalogue.dashboard.sharedCount', { count: entry.shared }) }}</p>
            </div>
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>
