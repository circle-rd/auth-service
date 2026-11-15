<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ExternalLink, Plus, Pencil, PowerOff, RefreshCw } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  createAppResource,
  createResource,
  disableResource,
  listAppResources,
  listMemberSchemes,
  listMyResources,
  requestValidation,
  updateResource,
  type Resource,
  type ResourceScheme,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime } from './format';

const props = defineProps<{
  appId: string;
  scope: 'app' | 'mine';
  canManage: boolean;
  canRead: boolean;
}>();

const { t } = useI18n();
const toast = useToast();

const resources = ref<Resource[]>([]);
const schemes = ref<ResourceScheme[]>([]);
const loading = ref(true);
const saving = ref(false);
const disabling = ref(false);
const showForm = ref(false);
const showDisable = ref(false);
const editing = ref<Resource | null>(null);
const selected = ref<Resource | null>(null);

const form = reactive({
  scheme: '',
  displayName: '',
  locator: '',
});

const schemeOptions = computed<SelectOption[]>(() =>
  schemes.value.map((scheme) => ({
    value: scheme.scheme,
    label: scheme.displayName,
    description: scheme.description ?? undefined,
  })),
);
const selectedScheme = computed(() =>
  schemes.value.find((scheme) => scheme.scheme === form.scheme) ?? null,
);
const isSsh = computed(() => form.scheme === 'ssh');
const canSave = computed(
  () => form.scheme.length > 0 && form.displayName.trim().length > 0 && (isSsh.value || form.locator.trim().length > 0),
);

function statusVariant(status: Resource['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'validated') return 'success';
  if (status === 'pending_validation' || status === 'validation_failed') return 'warning';
  return 'neutral';
}

async function load() {
  if (!props.canRead) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const [resourceRes, schemeRes] = await Promise.all([
      props.scope === 'app' ? listAppResources(props.appId) : listMyResources(),
      listMemberSchemes(props.appId),
    ]);
    resources.value = props.scope === 'app'
      ? resourceRes.resources
      : resourceRes.resources.filter((resource) => resource.applicationId === props.appId);
    schemes.value = schemeRes.schemes;
    if (!form.scheme && schemes.value[0]) form.scheme = schemes.value[0].scheme;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, {
    scheme: schemes.value[0]?.scheme ?? '',
    displayName: '',
    locator: '',
  });
  showForm.value = true;
}

function openEdit(resource: Resource) {
  editing.value = resource;
  Object.assign(form, {
    scheme: resource.scheme,
    displayName: resource.displayName,
    locator: '',
  });
  showForm.value = true;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    if (editing.value) {
      await updateResource(editing.value.id, { displayName: form.displayName.trim() });
      toast.success(t('share.resources.saved'));
    } else {
      const payload = {
        scheme: form.scheme,
        displayName: form.displayName.trim(),
        locator: isSsh.value ? undefined : form.locator.trim(),
      };
      if (props.scope === 'app') {
        await createAppResource(props.appId, payload);
      } else {
        await createResource({ applicationId: props.appId, ...payload });
      }
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

async function validate(resource: Resource) {
  try {
    const result = await requestValidation(resource.id);
    toast.success(t('share.resources.validationRequested'));
    if (result.validatorUrl) {
      const separator = result.validatorUrl.includes('?') ? '&' : '?';
      window.open(`${result.validatorUrl}${separator}resourceId=${resource.id}`, '_blank', 'noopener');
    }
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

function requestDisable(resource: Resource) {
  selected.value = resource;
  showDisable.value = true;
}

async function disable() {
  if (!selected.value) return;
  disabling.value = true;
  try {
    await disableResource(selected.value.id);
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

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.resources.name') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden md:table-cell">{{ t('share.resources.scheme') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.resources.uri') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden xl:table-cell">{{ t('share.resources.updatedAt') }}</th>
            <th class="px-4 py-3 text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="resource in resources" :key="resource.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3">
              <p class="font-medium text-surface-200">{{ resource.displayName }}</p>
              <p class="text-xs text-surface-500">{{ resource.applicationName }}</p>
            </td>
            <td class="px-4 py-3 text-surface-400 hidden md:table-cell">
              {{ resource.schemeDisplayName ?? resource.scheme }}
            </td>
            <td class="px-4 py-3 font-mono text-xs text-surface-500 hidden lg:table-cell break-all">
              {{ resource.uri }}
            </td>
            <td class="px-4 py-3">
              <BaseBadge :variant="statusVariant(resource.status)" dot>
                {{ t(`share.resourceStatuses.${resource.status}`) }}
              </BaseBadge>
              <p v-if="resource.validationError" class="text-[11px] text-danger-400 mt-1 max-w-64">
                {{ resource.validationError }}
              </p>
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden xl:table-cell">
              {{ formatDateTime(resource.updatedAt) }}
            </td>
            <td class="px-4 py-3">
              <div v-if="canManage" class="flex justify-end gap-1">
                <BaseButton
                  v-if="resource.status === 'pending_validation' || resource.status === 'validation_failed'"
                  variant="ghost"
                  size="sm"
                  @click="validate(resource)"
                >
                  <RefreshCw class="w-3.5 h-3.5" />{{ t('share.resources.validate') }}
                  <ExternalLink v-if="resource.status === 'pending_validation'" class="w-3 h-3" />
                </BaseButton>
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
          v-model="form.scheme"
          :label="t('share.resources.scheme')"
          :options="schemeOptions"
        />
        <p v-if="selectedScheme?.description" class="text-xs text-surface-500 -mt-2">
          {{ selectedScheme.description }}
        </p>
        <BaseInput v-model="form.displayName" :label="t('share.resources.name')" required />
        <BaseInput
          v-if="!editing && !isSsh"
          v-model="form.locator"
          :label="t('share.resources.locator')"
          required
          :hint="t('share.resources.locatorHint')"
        />
        <p v-if="!editing && isSsh" class="text-xs text-surface-500">
          {{ t('share.resources.sshLocatorHint') }}
        </p>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!canSave" @click="save">{{ t('common.save') }}</BaseButton>
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
