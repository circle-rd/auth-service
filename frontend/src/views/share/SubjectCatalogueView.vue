<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { BookOpen, Layers, Settings2 } from '@lucide/vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue';
import { useToast } from '@/composables/useToast';
import {
  listMemberApplications,
  listOwnerApplications,
  listResourceCatalogue,
  type AccessibleResource,
  type CatalogueApplication,
  type MemberApplication,
  type OwnerApplication,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import ShareWorkspace from './ShareWorkspace.vue';
import SharedResourcesPanel from './SharedResourcesPanel.vue';

const { t } = useI18n();
const toast = useToast();

const applications = ref<CatalogueApplication[]>([]);
const resources = ref<AccessibleResource[]>([]);
const memberApps = ref<MemberApplication[]>([]);
const ownerApps = ref<OwnerApplication[]>([]);
const selectedAppSlug = ref('');
const mineAppId = ref('');
const adminAppId = ref('');
const loading = ref(true);

const memberOptions = computed<SelectOption[]>(() =>
  memberApps.value.map((app) => ({ value: app.id, label: app.name })),
);
const ownerOptions = computed<SelectOption[]>(() =>
  ownerApps.value.map((app) => ({ value: app.id, label: app.name })),
);
const selectedResources = computed(() =>
  selectedAppSlug.value
    ? resources.value.filter((item) => item.applicationSlug === selectedAppSlug.value)
    : resources.value,
);
const selectedMineApp = computed(
  () => memberApps.value.find((app) => app.id === mineAppId.value) ?? null,
);
const selectedOwnerApp = computed(
  () => ownerApps.value.find((app) => app.id === adminAppId.value) ?? null,
);

function countFor(slug: string): number {
  return resources.value.filter((item) => item.applicationSlug === slug).length;
}

function accessLabel(item: AccessibleResource): string {
  if (item.accessKind === 'owner') return t('share.catalogue.accessOwner');
  if (item.accessKind === 'admin') return t('share.catalogue.accessAdmin');
  return t(`share.subjectTypes.${item.grantSubjectType ?? 'user'}`);
}

async function load() {
  loading.value = true;
  try {
    const [catalogue, memberRes, ownerRes] = await Promise.all([
      listResourceCatalogue(),
      listMemberApplications(),
      listOwnerApplications(),
    ]);
    applications.value = catalogue.applications;
    resources.value = catalogue.resources;
    memberApps.value = memberRes.applications;
    ownerApps.value = ownerRes.apps;
    mineAppId.value = memberApps.value[0]?.id ?? '';
    adminAppId.value = ownerApps.value[0]?.id ?? '';
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

watch(selectedAppSlug, () => {
  if (!selectedAppSlug.value) return;
  const member = memberApps.value.find((app) => app.slug === selectedAppSlug.value);
  if (member) mineAppId.value = member.id;
});

onMounted(() => void load());
</script>

<template>
  <AppLayout :title="t('share.catalogue.title')" :subtitle="t('share.catalogue.subtitle')">
    <div data-testid="subject-catalogue" class="space-y-6">
      <p class="text-sm text-surface-400">{{ t('share.catalogue.admissionNote') }}</p>

      <div v-if="loading" class="space-y-3">
        <SkeletonBlock class="h-24 w-full" />
        <SkeletonBlock class="h-40 w-full" />
      </div>

      <EmptyState
        v-else-if="applications.length === 0 && memberApps.length === 0"
        :title="t('share.catalogue.empty')"
        :message="t('share.catalogue.emptyHint')"
      >
        <template #icon><BookOpen class="w-8 h-8 text-surface-500" /></template>
      </EmptyState>

      <template v-else>
        <section v-if="applications.length > 0" class="rounded-2xl border border-surface-700/40 bg-surface-900/40 p-4 sm:p-5">
          <div class="flex items-center gap-2 mb-3">
            <Layers class="w-4 h-4 text-surface-400" />
            <h2 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">
              {{ t('share.catalogue.applications') }}
            </h2>
          </div>
          <div class="flex flex-wrap gap-2" data-testid="catalogue-applications">
            <button
              type="button"
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors',
                selectedAppSlug === ''
                  ? 'bg-primary-600/20 border-primary-500/50 text-primary-300'
                  : 'border-surface-700/50 text-surface-300 hover:bg-surface-800/60',
              ]"
              @click="selectedAppSlug = ''"
            >
              <span class="font-medium">{{ t('share.catalogue.allApplications') }}</span>
              <BaseBadge variant="neutral" size="sm">{{ resources.length }}</BaseBadge>
            </button>
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

        <div class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
          <table class="w-full text-sm">
            <thead class="bg-surface-800/50 text-surface-400">
              <tr>
                <th class="text-left font-medium px-4 py-3">{{ t('share.catalogue.resource') }}</th>
                <th class="text-left font-medium px-4 py-3 hidden md:table-cell">{{ t('share.catalogue.type') }}</th>
                <th class="text-left font-medium px-4 py-3">{{ t('share.catalogue.owner') }}</th>
                <th class="text-left font-medium px-4 py-3">{{ t('share.catalogue.access') }}</th>
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
                  <p class="font-mono text-xs text-surface-500 break-all">{{ item.resourceUri }}</p>
                </td>
                <td class="px-4 py-3 text-surface-400 hidden md:table-cell">{{ item.scheme }}</td>
                <td class="px-4 py-3 text-surface-300">{{ item.applicationName }}</td>
                <td class="px-4 py-3">
                  <BaseBadge variant="success">{{ accessLabel(item) }}</BaseBadge>
                </td>
              </tr>
              <tr v-if="selectedResources.length === 0">
                <td colspan="4" class="px-4 py-8 text-center text-sm text-surface-500">
                  {{ t('share.catalogue.noResources') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <section v-if="memberApps.length > 0" class="space-y-3">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-surface-200">{{ t('share.workspace.myResources') }}</h2>
              <p class="text-xs text-surface-500">{{ t('share.workspace.myResourcesHint') }}</p>
            </div>
            <BaseSelect v-model="mineAppId" :label="t('share.application')" :options="memberOptions" class="w-64" />
          </div>
          <SharedResourcesPanel
            v-if="selectedMineApp"
            :key="selectedMineApp.id"
            :app-id="selectedMineApp.id"
            scope="mine"
            can-manage
            can-read
          />
        </section>

        <section v-if="ownerApps.length > 0" class="space-y-3">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 class="flex items-center gap-2 text-sm font-semibold text-surface-200">
                <Settings2 class="w-4 h-4" />{{ t('share.workspace.administration') }}
              </h2>
              <p class="text-xs text-surface-500">{{ t('share.workspace.administrationHint') }}</p>
            </div>
            <BaseSelect v-model="adminAppId" :label="t('share.application')" :options="ownerOptions" class="w-64" />
          </div>
          <ShareWorkspace v-if="selectedOwnerApp" :key="selectedOwnerApp.id" :app-id="selectedOwnerApp.id" />
        </section>
      </template>
    </div>
  </AppLayout>
</template>
