<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Pencil, PowerOff } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  RESOURCE_STATUSES,
  RESOURCE_TYPES,
  RESOURCE_VISIBILITIES,
  createSharedResource,
  disableSharedResource,
  listSharedResources,
  updateSharedResource,
  type ResourceStatus,
  type ResourceType,
  type ResourceVisibility,
  type SharedResource,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime } from './format';

const props = defineProps<{
  appId: string;
  canManage: boolean;
  canRead: boolean;
}>();

const { t } = useI18n();
const toast = useToast();

const resources = ref<SharedResource[]>([]);
const loading = ref(true);
const saving = ref(false);
const disabling = ref(false);
const showForm = ref(false);
const showDisable = ref(false);
const editing = ref<SharedResource | null>(null);
const selected = ref<SharedResource | null>(null);

const form = reactive({
  resourceType: 'model' as ResourceType,
  slug: '',
  displayName: '',
  upstreamRef: '',
  status: 'draft' as ResourceStatus,
  visibility: 'invited_only' as ResourceVisibility,
});

const typeOptions = computed<SelectOption[]>(() =>
  RESOURCE_TYPES.map((value) => ({ value, label: t(`share.resourceTypes.${value}`) })),
);
const statusOptions = computed<SelectOption[]>(() =>
  RESOURCE_STATUSES.map((value) => ({ value, label: t(`share.resourceStatuses.${value}`) })),
);
const visibilityOptions = computed<SelectOption[]>(() =>
  RESOURCE_VISIBILITIES.map((value) => ({ value, label: t(`share.resourceVisibilities.${value}`) })),
);

const canSave = computed(() => form.slug.trim().length > 0 && form.displayName.trim().length > 0);

function statusVariant(status: ResourceStatus): 'success' | 'warning' | 'neutral' {
  if (status === 'published') return 'success';
  if (status === 'draft') return 'warning';
  return 'neutral';
}

async function load() {
  if (!props.canRead) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const res = await listSharedResources(props.appId);
    resources.value = res.resources;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, {
    resourceType: 'model',
    slug: '',
    displayName: '',
    upstreamRef: '',
    status: 'draft',
    visibility: 'invited_only',
  });
  showForm.value = true;
}

function openEdit(resource: SharedResource) {
  editing.value = resource;
  Object.assign(form, {
    resourceType: resource.resourceType,
    slug: resource.key.includes('/') ? resource.key.slice(resource.key.indexOf('/') + 1) : resource.key,
    displayName: resource.displayName,
    upstreamRef: resource.upstreamRef ?? '',
    status: resource.status,
    visibility: resource.visibility,
  });
  showForm.value = true;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const payload = {
      slug: form.slug.trim(),
      displayName: form.displayName.trim(),
      upstreamRef: form.upstreamRef.trim() || null,
      status: form.status,
      visibility: form.visibility,
    };
    if (editing.value) {
      await updateSharedResource(props.appId, editing.value.id, payload);
      toast.success(t('share.resources.saved'));
    } else {
      await createSharedResource(props.appId, { ...payload, resourceType: form.resourceType });
      toast.success(t('share.resources.created'));
    }
    showForm.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

function requestDisable(resource: SharedResource) {
  selected.value = resource;
  showDisable.value = true;
}

async function disable() {
  if (!selected.value) return;
  disabling.value = true;
  try {
    await disableSharedResource(props.appId, selected.value.id);
    toast.success(t('share.resources.disabledToast'));
    showDisable.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    disabling.value = false;
  }
}

watch(() => props.appId, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-surface-400">{{ t('share.resources.hint') }}</p>
      <BaseButton v-if="canManage" size="sm" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.resources.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="resources.length === 0"
      :title="t('share.resources.empty')"
      :message="t('share.resources.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-hidden bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.resources.name') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden md:table-cell">{{ t('share.resources.type') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.resources.key') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden xl:table-cell">{{ t('share.resources.updatedAt') }}</th>
            <th class="px-4 py-3 text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="resource in resources" :key="resource.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3">
              <p class="font-medium text-surface-200">{{ resource.displayName }}</p>
              <p class="text-xs text-surface-500">{{ t(`share.resourceVisibilities.${resource.visibility}`) }}</p>
            </td>
            <td class="px-4 py-3 text-surface-400 hidden md:table-cell">
              {{ t(`share.resourceTypes.${resource.resourceType}`) }}
            </td>
            <td class="px-4 py-3 font-mono text-xs text-surface-500 hidden lg:table-cell break-all">
              {{ resource.key }}
            </td>
            <td class="px-4 py-3">
              <BaseBadge :variant="statusVariant(resource.status)" dot>
                {{ t(`share.resourceStatuses.${resource.status}`) }}
              </BaseBadge>
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden xl:table-cell">
              {{ formatDateTime(resource.updatedAt) }}
            </td>
            <td class="px-4 py-3">
              <div v-if="canManage" class="flex justify-end gap-1">
                <BaseButton variant="ghost" size="sm" @click="openEdit(resource)">
                  <Pencil class="w-3.5 h-3.5" />{{ t('common.edit') }}
                </BaseButton>
                <BaseButton
                  v-if="resource.status !== 'disabled'"
                  variant="ghost"
                  size="sm"
                  @click="requestDisable(resource)"
                >
                  <PowerOff class="w-3.5 h-3.5" />{{ t('share.resources.disable') }}
                </BaseButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BaseModal
      :open="showForm"
      :title="editing ? t('share.resources.editTitle') : t('share.resources.createTitle')"
      size="md"
      @close="showForm = false"
    >
      <div class="space-y-4">
        <BaseSelect
          v-if="!editing"
          v-model="form.resourceType"
          :label="t('share.resources.type')"
          :options="typeOptions"
        />
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BaseInput v-model="form.displayName" :label="t('share.resources.name')" required />
          <BaseInput v-model="form.slug" :label="t('share.resources.slug')" required :hint="t('share.resources.slugHint')" />
        </div>
        <BaseInput v-model="form.upstreamRef" :label="t('share.resources.upstreamRef')" />
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BaseSelect v-model="form.status" :label="t('common.status')" :options="statusOptions" />
          <BaseSelect
            v-model="form.visibility"
            :label="t('share.resources.visibility')"
            :options="visibilityOptions"
          />
        </div>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!canSave" @click="save">
          {{ t('common.save') }}
        </BaseButton>
      </template>
    </BaseModal>

    <ConfirmDialog
      :open="showDisable"
      :title="t('share.resources.disableTitle')"
      :message="t('share.resources.disableMessage')"
      :confirm-label="t('share.resources.disable')"
      :loading="disabling"
      @confirm="disable"
      @cancel="showDisable = false"
    />
  </div>
</template>
