<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useApplicationsStore } from '@/stores/applications';
import { createApplication, rotateSecret } from '@/api/applications';
import { useToast } from '@/composables/useToast';
import type { Application } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import CopyField from '@/components/ui/CopyField.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import { Plus, AppWindow, MoreHorizontal, Eye, RefreshCw, Trash2, Globe, Lock, AlertTriangle } from 'lucide-vue-next';

const { t } = useI18n();
const router = useRouter();
const store = useApplicationsStore();
const toast = useToast();

const showCreateModal = ref(false);
const showDeleteConfirm = ref(false);
const showSecretModal = ref(false);
const showRotateConfirm = ref(false);
const formLoading = ref(false);
const deleteLoading = ref(false);
const rotateLoading = ref(false);
const selectedApp = ref<Application | null>(null);
const newSecret = ref('');
const actionMenu = ref<string | null>(null);
const filterActive = ref('');
const filterType = ref('');

const createForm = ref({
  name: '',
  slug: '',
  description: '',
  url: '',
  icon: '',
  isActive: true,
  isPublic: false,
  skipConsent: false,
  isMfaRequired: false,
  allowRegister: true,
  allowedScopes: ['openid', 'profile', 'email'] as string[],
  redirectUris: [''] as string[],
  enabledSocialProviders: null as string[] | null,
});

onMounted(() => store.fetchApplications());

const filtered = computed(() => {
  let apps = store.applications;
  if (filterActive.value === 'active') apps = apps.filter(a => a.isActive);
  if (filterActive.value === 'inactive') apps = apps.filter(a => !a.isActive);
  if (filterType.value === 'public') apps = apps.filter(a => a.isPublic);
  if (filterType.value === 'confidential') apps = apps.filter(a => !a.isPublic);
  return apps;
});

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

watch(() => createForm.value.name, (name) => {
  createForm.value.slug = slugify(name);
});

const createModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'success' | 'neutral' | 'warning' | 'info' | 'primary' | 'error' }> = [];
  tags.push({ label: createForm.value.isActive ? 'Active' : 'Inactive', variant: createForm.value.isActive ? 'success' : 'neutral' });
  tags.push({ label: createForm.value.isPublic ? 'Public (PKCE)' : 'Confidential', variant: createForm.value.isPublic ? 'info' : 'neutral' });
  if (createForm.value.isMfaRequired) tags.push({ label: 'MFA', variant: 'warning' });
  if (createForm.value.skipConsent) tags.push({ label: 'Skip consent', variant: 'neutral' });
  return tags;
});

const SCOPES = ['openid', 'profile', 'email', 'offline_access'];

function toggleScope(scope: string) {
  const idx = createForm.value.allowedScopes.indexOf(scope);
  if (idx >= 0) {
    createForm.value.allowedScopes.splice(idx, 1);
  } else {
    createForm.value.allowedScopes.push(scope);
  }
}

function addRedirectUri() { createForm.value.redirectUris.push(''); }
function removeRedirectUri(i: number) { createForm.value.redirectUris.splice(i, 1); }

async function handleCreate() {
  if (!createForm.value.name || !createForm.value.slug) return;
  formLoading.value = true;
  try {
    const body = {
      name: createForm.value.name,
      slug: createForm.value.slug,
      description: createForm.value.description || undefined,
      url: createForm.value.url || undefined,
      icon: createForm.value.icon || undefined,
      isActive: createForm.value.isActive,
      isPublic: createForm.value.isPublic,
      skipConsent: createForm.value.skipConsent,
      isMfaRequired: createForm.value.isMfaRequired,
      allowRegister: createForm.value.allowRegister,
      allowedScopes: createForm.value.allowedScopes,
      redirectUris: createForm.value.redirectUris.filter(Boolean),
    };
    const res = await createApplication(body);
    await store.fetchApplications();
    if (res.clientSecret) {
      newSecret.value = res.clientSecret;
      showCreateModal.value = false;
      showSecretModal.value = true;
    } else {
      toast.success('Application created');
      showCreateModal.value = false;
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create application');
  } finally {
    formLoading.value = false;
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
          <select v-model="filterActive" class="px-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-300 focus:outline-none focus:ring-2 focus:ring-primary-500/50">
            <option value="">All statuses</option>
            <option value="active">{{ t('common.active') }}</option>
            <option value="inactive">{{ t('common.inactive') }}</option>
          </select>
          <select v-model="filterType" class="px-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-300 focus:outline-none focus:ring-2 focus:ring-primary-500/50">
            <option value="">All types</option>
            <option value="public">{{ t('applications.public') }}</option>
            <option value="confidential">{{ t('applications.confidential') }}</option>
          </select>
        </div>
        <BaseButton @click="showCreateModal = true">
          <Plus class="w-4 h-4" />
          {{ t('applications.createApp') }}
        </BaseButton>
      </div>

      <div v-if="store.loading" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div v-for="i in 3" :key="i" class="h-48 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-2xl" />
      </div>

      <EmptyState v-else-if="filtered.length === 0" :title="t('applications.noApps')" :message="t('applications.noAppsMessage')">
        <template #icon><AppWindow class="w-8 h-8 text-surface-500" /></template>
        <template #action>
          <BaseButton @click="showCreateModal = true" size="sm"><Plus class="w-3.5 h-3.5" />{{ t('applications.createApp') }}</BaseButton>
        </template>
      </EmptyState>

      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="app in filtered"
          :key="app.id"
          class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 hover:border-surface-600/60 transition-all duration-200 group"
        >
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl overflow-hidden shrink-0 bg-surface-800 flex items-center justify-center">
                <img v-if="app.icon" :src="app.icon" class="w-full h-full object-cover" />
                <span v-else class="text-sm font-bold text-surface-400">{{ app.name[0].toUpperCase() }}</span>
              </div>
              <div>
                <p class="text-sm font-semibold text-surface-200">{{ app.name }}</p>
                <p class="text-xs font-mono text-surface-500">{{ app.slug }}</p>
              </div>
            </div>
            <div class="relative">
              <button @click.stop="actionMenu = actionMenu === app.id ? null : app.id" class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors opacity-0 group-hover:opacity-100">
                <MoreHorizontal class="w-4 h-4" />
              </button>
              <div v-if="actionMenu === app.id" class="absolute right-0 top-full mt-1 w-44 bg-surface-800 border border-surface-700/50 rounded-xl shadow-xl z-20 overflow-hidden animate-slide-up">
                <button @click="router.push(`/applications/${app.id}`)" class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"><Eye class="w-4 h-4" />View</button>
                <button @click="toggleActive(app)" class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50">{{ app.isActive ? 'Deactivate' : 'Activate' }}</button>
                <button v-if="!app.isPublic" @click="selectedApp = app; showRotateConfirm = true; actionMenu = null" class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"><RefreshCw class="w-4 h-4" />{{ t('applications.rotateSecret') }}</button>
                <button @click="selectedApp = app; showDeleteConfirm = true; actionMenu = null" class="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-surface-700/50 flex items-center gap-2"><Trash2 class="w-4 h-4" />Delete</button>
              </div>
            </div>
          </div>

          <p v-if="app.description" class="text-xs text-surface-500 mb-3 line-clamp-2">{{ app.description }}</p>

          <div class="flex flex-wrap gap-1.5 mb-3">
            <BaseBadge :variant="app.isActive ? 'success' : 'neutral'" size="sm" dot>{{ app.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
            <BaseBadge variant="neutral" size="sm">
              <component :is="app.isPublic ? Globe : Lock" class="w-3 h-3" />
              {{ app.isPublic ? t('applications.public') : t('applications.confidential') }}
            </BaseBadge>
            <BaseBadge v-if="app.isMfaRequired" variant="warning" size="sm">MFA</BaseBadge>
          </div>

          <div class="text-xs text-surface-600 mb-4">
            {{ app.redirectUris.length }} redirect URIs · {{ formatDate(app.createdAt) }}
          </div>

          <BaseButton variant="ghost" size="sm" class="w-full" @click="router.push(`/applications/${app.id}`)">
            <Eye class="w-3.5 h-3.5" />
            View details
          </BaseButton>
        </div>
      </div>
    </div>

    <EntityModal
      :open="showCreateModal"
      :name="createForm.name || t('applications.createApp')"
      :subtitle="createForm.slug ? createForm.slug : 'app-slug'"
      :icon-url="createForm.icon || null"
      :icon-letter="createForm.name ? createForm.name[0].toUpperCase() : 'A'"
      icon-shape="square"
      :tags="createModalTags"
      size="xl"
      @close="showCreateModal = false"
    >
      <form @submit.prevent="handleCreate" class="space-y-5">
        <div class="grid grid-cols-2 gap-4">
          <BaseInput v-model="createForm.name" :label="t('applications.name')" required />
          <BaseInput v-model="createForm.slug" :label="t('applications.slug')" required />
        </div>
        <BaseInput v-model="createForm.description" :label="t('applications.description')" />
        <div class="grid grid-cols-2 gap-4">
          <BaseInput v-model="createForm.url" :label="t('applications.url')" placeholder="https://app.example.com" />
          <BaseInput v-model="createForm.icon" :label="t('applications.icon')" placeholder="https://..." />
        </div>

        <div class="pt-1">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-3">Options</p>
          <div class="grid grid-cols-2 gap-x-8 gap-y-3">
            <BaseToggle v-model="createForm.isActive" :label="t('applications.isActive')" />
            <BaseToggle v-model="createForm.isPublic" :label="t('applications.isPublic')" description="PKCE only, no secret" />
            <BaseToggle v-model="createForm.skipConsent" :label="t('applications.skipConsent')" />
            <BaseToggle v-model="createForm.isMfaRequired" :label="t('applications.isMfaRequired')" />
            <BaseToggle v-model="createForm.allowRegister" :label="t('applications.allowRegister')" />
          </div>
        </div>

        <div>
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">{{ t('applications.allowedScopes') }}</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="scope in SCOPES"
              :key="scope"
              type="button"
              @click="toggleScope(scope)"
              :class="['px-3 py-1.5 rounded-md text-xs font-medium border transition-colors', createForm.allowedScopes.includes(scope) ? 'bg-primary-600/20 border-primary-500/40 text-primary-300' : 'bg-surface-800/60 border-surface-700/60 text-surface-500 hover:border-surface-500 hover:text-surface-300']"
            >
              {{ scope }}
            </button>
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">{{ t('applications.redirectUris') }}</p>
            <button type="button" @click="addRedirectUri" class="text-xs text-primary-400 hover:text-primary-300 transition-colors font-medium">+ Add URI</button>
          </div>
          <div class="space-y-2">
            <div v-for="(_, i) in createForm.redirectUris" :key="i" class="flex gap-2">
              <input
                v-model="createForm.redirectUris[i]"
                placeholder="https://your-app.com/callback"
                class="flex-1 px-3 py-2 text-sm bg-surface-800/80 border border-surface-700/60 rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all"
              />
              <button type="button" @click="removeRedirectUri(i)" class="px-2 text-surface-600 hover:text-red-400 transition-colors text-lg leading-none">✕</button>
            </div>
          </div>
        </div>
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showCreateModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreate">{{ t('common.create') }}</BaseButton>
      </template>
    </EntityModal>

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
        <div class="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-500/8 border border-amber-500/20">
          <AlertTriangle class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p class="text-sm text-amber-300/90">{{ t('applications.secretCreated') }}</p>
        </div>
        <CopyField :value="newSecret" label="Client Secret" />
      </div>
      <template #footer>
        <BaseButton @click="showSecretModal = false">{{ t('common.close') }}</BaseButton>
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
