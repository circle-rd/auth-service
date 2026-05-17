<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useApplicationsStore } from '@/stores/applications';
import { rotateSecret } from '@/api/applications';
import { useToast } from '@/composables/useToast';
import type { Application } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import CopyField from '@/components/ui/CopyField.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import ApplicationFormModal from '@/components/applications/ApplicationFormModal.vue';
import Sparkline from '@/components/ui/Sparkline.vue';
import { getApplicationsActivity, type AppActivityEntry } from '@/api/stats';
import {
  Plus,
  AppWindow,
  MoreHorizontal,
  Eye,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  Globe,
  Lock,
  AlertTriangle,
  Activity,
} from 'lucide-vue-next';

const { t } = useI18n();
const router = useRouter();
const store = useApplicationsStore();
const toast = useToast();

const showFormModal = ref(false);
const editingApp = ref<Application | null>(null);
const showDeleteConfirm = ref(false);
const showSecretModal = ref(false);
const showRotateConfirm = ref(false);
const deleteLoading = ref(false);
const rotateLoading = ref(false);
const selectedApp = ref<Application | null>(null);
const newSecret = ref('');
const actionMenu = ref<string | null>(null);
const filterActive = ref('');
const filterType = ref('');

onMounted(() => {
  store.fetchApplications();
  void loadActivity();
});

const activity = ref<Map<string, AppActivityEntry>>(new Map());
async function loadActivity() {
  try {
    const res = await getApplicationsActivity();
    const m = new Map<string, AppActivityEntry>();
    res.applications.forEach(a => m.set(a.appId, a));
    activity.value = m;
  } catch {
    // Silent — sparklines are decorative.
  }
}

const filtered = computed(() => {
  let apps = store.applications;
  if (filterActive.value === 'active') apps = apps.filter((a) => a.isActive);
  if (filterActive.value === 'inactive') apps = apps.filter((a) => !a.isActive);
  if (filterType.value === 'public') apps = apps.filter((a) => a.isPublic);
  if (filterType.value === 'confidential') apps = apps.filter((a) => !a.isPublic);
  return apps;
});

function openCreate() {
  editingApp.value = null;
  showFormModal.value = true;
}

function openEdit(app: Application) {
  editingApp.value = app;
  showFormModal.value = true;
  actionMenu.value = null;
}

async function onSaved(_app: Application, clientSecret?: string) {
  await store.fetchApplications();
  if (clientSecret) {
    newSecret.value = clientSecret;
    showFormModal.value = false;
    showSecretModal.value = true;
  } else {
    showFormModal.value = false;
  }
}

async function handleDelete() {
  if (!selectedApp.value) return;
  deleteLoading.value = true;
  try {
    await store.deleteApplication(selectedApp.value.id);
    toast.success('Application deleted');
    showDeleteConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to delete');
  } finally {
    deleteLoading.value = false;
  }
}

async function handleRotate() {
  if (!selectedApp.value) return;
  rotateLoading.value = true;
  try {
    const res = await rotateSecret(selectedApp.value.id);
    newSecret.value = res.clientSecret;
    showRotateConfirm.value = false;
    showSecretModal.value = true;
    toast.success('Secret rotated');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to rotate secret');
  } finally {
    rotateLoading.value = false;
  }
}

async function toggleActive(app: Application) {
  await store.updateApplication(app.id, { isActive: !app.isActive });
  toast.success(`Application ${!app.isActive ? 'activated' : 'deactivated'}`);
  actionMenu.value = null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
</script>

<template>
  <AppLayout :title="t('applications.title')" :subtitle="t('applications.subtitle')">
    <div class="space-y-5">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex gap-2">
          <select
            v-model="filterActive"
            class="px-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-300 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
          >
            <option value="">All statuses</option>
            <option value="active">{{ t('common.active') }}</option>
            <option value="inactive">{{ t('common.inactive') }}</option>
          </select>
          <select
            v-model="filterType"
            class="px-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-300 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
          >
            <option value="">All types</option>
            <option value="public">{{ t('applications.public') }}</option>
            <option value="confidential">{{ t('applications.confidential') }}</option>
          </select>
        </div>
        <BaseButton @click="openCreate">
          <Plus class="w-4 h-4" />
          {{ t('applications.createApp') }}
        </BaseButton>
      </div>

      <div
        v-if="store.loading"
        class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      >
        <div
          v-for="i in 3"
          :key="i"
          class="h-48 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-2xl"
        />
      </div>

      <EmptyState
        v-else-if="filtered.length === 0"
        :title="t('applications.noApps')"
        :message="t('applications.noAppsMessage')"
      >
        <template #icon><AppWindow class="w-8 h-8 text-surface-500" /></template>
        <template #action>
          <BaseButton @click="openCreate" size="sm">
            <Plus class="w-3.5 h-3.5" />{{ t('applications.createApp') }}
          </BaseButton>
        </template>
      </EmptyState>

      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="app in filtered"
          :key="app.id"
          class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 hover:border-surface-600/60 transition-all duration-200 group cursor-pointer"
          @click="router.push(`/applications/${app.id}`)"
        >
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-xl overflow-hidden shrink-0 bg-surface-800 flex items-center justify-center"
              >
                <img v-if="app.icon" :src="app.icon" class="w-full h-full object-cover" />
                <span v-else class="text-sm font-bold text-surface-400">
                  {{ app.name[0].toUpperCase() }}
                </span>
              </div>
              <div>
                <p class="text-sm font-semibold text-surface-200">{{ app.name }}</p>
                <p class="text-xs font-mono text-surface-500">{{ app.slug }}</p>
              </div>
            </div>
            <div class="relative" @click.stop>
              <button
                @click.stop="actionMenu = actionMenu === app.id ? null : app.id"
                class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors opacity-0 group-hover:opacity-100"
              >
                <MoreHorizontal class="w-4 h-4" />
              </button>
              <div
                v-if="actionMenu === app.id"
                class="absolute right-0 top-full mt-1 w-44 bg-surface-800 border border-surface-700/50 rounded-xl shadow-xl z-20 overflow-hidden animate-slide-up"
              >
                <button
                  @click="router.push(`/applications/${app.id}`)"
                  class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"
                >
                  <Eye class="w-4 h-4" />View
                </button>
                <button
                  @click="openEdit(app)"
                  class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"
                >
                  <Pencil class="w-4 h-4" />{{ t('common.edit') }}
                </button>
                <button
                  @click="toggleActive(app)"
                  class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"
                >
                  <component :is="app.isActive ? PowerOff : Power" class="w-4 h-4" />
                  {{ app.isActive ? t('common.deactivate') : t('common.activate') }}
                </button>
                <button
                  v-if="!app.isPublic"
                  @click="
                    selectedApp = app;
                    showRotateConfirm = true;
                    actionMenu = null;
                  "
                  class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"
                >
                  <RefreshCw class="w-4 h-4" />{{ t('applications.rotateSecret') }}
                </button>
                <button
                  @click="
                    selectedApp = app;
                    showDeleteConfirm = true;
                    actionMenu = null;
                  "
                  class="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-surface-700/50 flex items-center gap-2"
                >
                  <Trash2 class="w-4 h-4" />{{ t('common.delete') }}
                </button>
              </div>
            </div>
          </div>

          <p
            v-if="app.description"
            class="text-xs text-surface-500 mb-3 line-clamp-2"
          >
            {{ app.description }}
          </p>

          <div class="flex flex-wrap gap-1.5 mb-3">
            <BaseBadge
              :variant="app.isActive ? 'success' : 'neutral'"
              size="sm"
              dot
            >
              {{ app.isActive ? t('common.active') : t('common.inactive') }}
            </BaseBadge>
            <BaseBadge variant="neutral" size="sm">
              <component :is="app.isPublic ? Globe : Lock" class="w-3 h-3" />
              {{ app.isPublic ? t('applications.public') : t('applications.confidential') }}
            </BaseBadge>
            <BaseBadge v-if="app.isMfaRequired" variant="warning" size="sm">
              MFA
            </BaseBadge>
          </div>

          <div class="text-xs text-surface-600">
            {{ app.redirectUris.length }} redirect URIs · {{ formatDate(app.createdAt) }}
          </div>

          <div class="mt-3 pt-3 border-t border-surface-800/40 flex items-center justify-between">
            <div class="flex items-center gap-3 text-xs">
              <span
                class="inline-flex items-center gap-1.5"
                :class="(activity.get(app.id)?.online ?? 0) > 0 ? 'text-emerald-400' : 'text-surface-600'"
                :title="t('applications.activity.online')"
              >
                <Activity class="w-3 h-3" />
                {{ activity.get(app.id)?.online ?? 0 }}
              </span>
              <span class="text-surface-500">
                {{ activity.get(app.id)?.last7dLogins ?? 0 }} · {{ t('applications.activity.last7d') }}
              </span>
            </div>
            <Sparkline
              :values="activity.get(app.id)?.sparkline ?? []"
              :width="72"
              :height="20"
            />
          </div>
        </div>
      </div>
    </div>

    <ApplicationFormModal
      :open="showFormModal"
      :application="editingApp"
      @close="showFormModal = false"
      @saved="onSaved"
    />

    <EntityModal
      :open="showSecretModal"
      name="Client Secret"
      subtitle="Store this securely — shown only once"
      icon-shape="square"
      icon-letter="K"
      :tags="[{ label: 'Confidential', variant: 'warning' }]"
      size="md"
      @close="showSecretModal = false"
    >
      <div class="space-y-4">
        <div
          class="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-500/8 border border-amber-500/20"
        >
          <AlertTriangle class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p class="text-sm text-amber-300/90">
            {{ t('applications.secretCreated') }}
          </p>
        </div>
        <CopyField :value="newSecret" label="Client Secret" />
      </div>
      <template #footer>
        <BaseButton @click="showSecretModal = false">
          {{ t('common.close') }}
        </BaseButton>
      </template>
    </EntityModal>

    <ConfirmDialog
      :open="showRotateConfirm"
      :title="t('applications.rotateSecret')"
      :message="t('applications.rotateSecretConfirm')"
      :confirm-label="t('applications.rotateSecret')"
      :loading="rotateLoading"
      @confirm="handleRotate"
      @cancel="showRotateConfirm = false"
    />

    <ConfirmDialog
      :open="showDeleteConfirm"
      :title="t('applications.deleteApp')"
      :message="t('applications.confirmDelete')"
      :confirm-label="t('common.delete')"
      :loading="deleteLoading"
      @confirm="handleDelete"
      @cancel="showDeleteConfirm = false"
    />
  </AppLayout>
</template>
