<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { BookOpen, Layers } from '@lucide/vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import { useToast } from '@/composables/useToast';
import {
  listResourceCatalogue,
  type CatalogueApplication,
  type ResourceCatalogueItem,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';

const { t } = useI18n();
const toast = useToast();

const applications = ref<CatalogueApplication[]>([]);
const resources = ref<ResourceCatalogueItem[]>([]);
const selectedAppSlug = ref('');
const selectedModelId = ref('');
const loading = ref(true);

const selectedResources = computed(() =>
  resources.value.filter((item) => item.ownerApplicationSlug === selectedAppSlug.value),
);
const models = computed(() =>
  selectedResources.value.filter((item) => item.resourceType === 'model'),
);
const modelOptions = computed<SelectOption[]>(() =>
  models.value.map((item) => ({
    value: item.resourceId,
    label: item.displayName,
    description: item.resourceKey,
  })),
);
const selectedModel = computed(
  () => models.value.find((item) => item.resourceId === selectedModelId.value) ?? null,
);
const hasClientRestrictions = computed(() =>
  selectedResources.value.some((item) => item.restrictedToClientIds !== null),
);

function countFor(slug: string): number {
  return resources.value.filter((item) => item.ownerApplicationSlug === slug).length;
}

watch(selectedAppSlug, () => {
  selectedModelId.value = models.value[0]?.resourceId ?? '';
});

async function load() {
  loading.value = true;
  try {
    const res = await listResourceCatalogue();
    applications.value = res.applications;
    resources.value = res.resources;
    selectedAppSlug.value = res.applications[0]?.slug ?? '';
    selectedModelId.value = models.value[0]?.resourceId ?? '';
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <AppLayout :title="t('share.catalogue.title')" :subtitle="t('share.catalogue.subtitle')">
    <div data-testid="subject-catalogue" class="space-y-5">
      <p class="text-sm text-surface-400">{{ t('share.catalogue.admissionNote') }}</p>

      <div v-if="loading" class="space-y-3">
        <SkeletonBlock class="h-24 w-full" />
        <SkeletonBlock class="h-40 w-full" />
      </div>

      <EmptyState
        v-else-if="applications.length === 0"
        :title="t('share.catalogue.empty')"
        :message="t('share.catalogue.emptyHint')"
      >
        <template #icon><BookOpen class="w-8 h-8 text-surface-500" /></template>
      </EmptyState>

      <template v-else>
        <section class="rounded-2xl border border-surface-700/40 bg-surface-900/40 p-4 sm:p-5">
          <div class="flex items-center gap-2 mb-3">
            <Layers class="w-4 h-4 text-surface-400" />
            <h2 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">
              {{ t('share.catalogue.applications') }}
            </h2>
          </div>
          <div class="flex flex-wrap gap-2" data-testid="catalogue-applications">
            <button
              v-for="app in applications"
              :key="app.slug"
              type="button"
              :data-testid="`catalogue-app-${app.slug}`"
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors',
                selectedAppSlug === app.slug
                  ? 'bg-primary-600/20 border-primary-500/50 text-primary-300'
                  : 'border-surface-700/50 text-surface-300 hover:bg-surface-800/60',
              ]"
              @click="selectedAppSlug = app.slug"
            >
              <span class="font-medium">{{ app.name }}</span>
              <BaseBadge variant="neutral" size="sm">{{ countFor(app.slug) }}</BaseBadge>
            </button>
          </div>
        </section>

        <section
          v-if="models.length > 0"
          class="rounded-2xl border border-surface-700/40 bg-surface-900/40 p-5 space-y-4"
        >
          <div class="flex flex-wrap items-end justify-between gap-4">
            <div class="w-full max-w-sm" data-testid="model-selector">
              <BaseSelect
                v-model="selectedModelId"
                :label="t('share.catalogue.modelSelector')"
                :options="modelOptions"
              />
            </div>
            <p class="text-xs text-surface-500 pb-2">
              {{ t('share.catalogue.modelCount', { count: models.length }) }}
            </p>
          </div>
          <div v-if="selectedModel" data-testid="selected-model" class="rounded-xl bg-surface-800/50 p-4">
            <p class="text-lg font-semibold text-surface-100">{{ selectedModel.displayName }}</p>
            <p class="font-mono text-xs text-surface-500 mt-1 break-all">{{ selectedModel.resourceUri }}</p>
            <div class="flex flex-wrap gap-2 mt-3">
              <BaseBadge variant="neutral">{{ selectedModel.ownerApplicationName }}</BaseBadge>
              <BaseBadge variant="success">{{ selectedModel.planName }}</BaseBadge>
            </div>
          </div>
        </section>

        <div class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
          <table class="w-full text-sm">
            <thead class="bg-surface-800/50 text-surface-400">
              <tr>
                <th class="text-left font-medium px-4 py-3">{{ t('share.catalogue.resource') }}</th>
                <th class="text-left font-medium px-4 py-3 hidden md:table-cell">{{ t('share.catalogue.type') }}</th>
                <th class="text-left font-medium px-4 py-3">{{ t('share.catalogue.owner') }}</th>
                <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.catalogue.plan') }}</th>
                <th
                  v-if="hasClientRestrictions"
                  class="text-left font-medium px-4 py-3"
                >
                  {{ t('share.catalogue.clients') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in selectedResources"
                :key="item.resourceId"
                data-testid="catalogue-item"
                class="border-t border-surface-800/60"
              >
                <td class="px-4 py-3">
                  <p class="font-medium text-surface-200">{{ item.displayName }}</p>
                  <p class="font-mono text-xs text-surface-500 break-all">{{ item.resourceKey }}</p>
                </td>
                <td class="px-4 py-3 text-surface-400 hidden md:table-cell">
                  {{ t(`share.resourceTypes.${item.resourceType}`) }}
                </td>
                <td class="px-4 py-3 text-surface-300">{{ item.ownerApplicationName }}</td>
                <td class="px-4 py-3 text-surface-400 hidden lg:table-cell">{{ item.planName }}</td>
                <td
                  v-if="hasClientRestrictions"
                  class="px-4 py-3 text-xs text-surface-500"
                >
                  {{ item.restrictedToClientIds?.join(', ') ?? t('share.catalogue.anyClient') }}
                </td>
              </tr>
              <tr v-if="selectedResources.length === 0">
                <td colspan="5" class="px-4 py-8 text-center text-sm text-surface-500">
                  {{ t('share.catalogue.noResources') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </AppLayout>
</template>
