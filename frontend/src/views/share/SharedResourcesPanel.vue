<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ExternalLink, Plus, Pencil, PowerOff, RefreshCw, Terminal, Trash2 } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import {
  createAppResource,
  createResource,
  listAppResources,
  listMemberSchemes,
  listMyResources,
  removeResource,
  requestValidation,
  updateResource,
  type Resource,
  type ResourceScheme,
} from '@/api/resources';
import { formatDateTime } from './format';
import ResourceFormModal, { type ResourceFormPayload } from './ResourceFormModal.vue';
import SshTargetDialog from './SshTargetDialog.vue';

const props = withDefaults(defineProps<{
  appId: string;
  scope: 'app' | 'mine';
  canManage: boolean;
  canRead: boolean;
  canCreate?: boolean;
  // Restricts the list, and the creation form, to one resource type.
  scheme?: string;
  // Application administrators declare gateway objects and choose wider audiences.
  appAdmin?: boolean;
}>(), {
  canCreate: true,
});

const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();
const toast = useToast();
const auth = useAuthStore();

const resources = ref<Resource[]>([]);
const schemes = ref<ResourceScheme[]>([]);
const loading = ref(true);
const saving = ref(false);
const disabling = ref(false);
const showForm = ref(false);
const showDisable = ref(false);
const formError = ref('');
const editing = ref<Resource | null>(null);
const selected = ref<Resource | null>(null);
const sshResource = ref<Resource | null>(null);
const validatorLink = ref<string | null>(null);

const schemeByName = computed(() => new Map(schemes.value.map((entry) => [entry.scheme, entry])));


// Choosing which gateway objects an application exposes is a platform decision.
function awaitsPlatformValidation(resource: Resource): boolean {
  return schemeByName.value.get(resource.scheme)?.adapter === 'litellm' && !auth.isAdmin();
}

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
    resources.value = (props.scope === 'app'
      ? resourceRes.resources
      : resourceRes.resources.filter((resource) => resource.applicationId === props.appId)
    ).filter((resource) => !props.scheme || resource.scheme === props.scheme);
    schemes.value = schemeRes.schemes;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  formError.value = '';
  showForm.value = true;
}

function openEdit(resource: Resource) {
  editing.value = resource;
  formError.value = '';
  showForm.value = true;
}

async function save(form: ResourceFormPayload) {
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      await updateResource(editing.value.id, { displayName: form.displayName });
      toast.success(t('share.resources.saved'));
    } else {
      const payload = { scheme: form.scheme, displayName: form.displayName, locator: form.locator };
      if (props.scope === 'app') {
        await createAppResource(props.appId, payload);
      } else {
        await createResource({ applicationId: props.appId, ...payload, audience: form.audience });
      }
      toast.success(t('share.resources.created'));
    }
    showForm.value = false;
    await load();
    emit('changed');
  } catch (err) {
    formError.value = err instanceof Error ? err.message : t('share.saveError');
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
      // Render the link instead of opening it after the await: browsers may
      // block window.open once the user activation has expired.
      validatorLink.value = `${result.validatorUrl}${separator}resourceId=${resource.id}`;
    } else {
      validatorLink.value = null;
    }
    await load();
    emit('changed');
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
    await removeResource(selected.value.id);
    toast.success(t('share.resources.deletedToast'));
    showDisable.value = false;
    await load();
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    disabling.value = false;
  }
}

// A resource that was never validated could not be used: removing it deletes it.
function neverValidated(resource: Resource): boolean {
  return resource.validatedAt === null;
}

watch([() => props.appId, () => props.scheme], () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-surface-400">{{ t('share.resources.hint') }}</p>
      <BaseButton v-if="canCreate" size="sm" class="shrink-0" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.resources.add') }}
      </BaseButton>
    </div>

    <div v-if="validatorLink" class="rounded-xl border border-primary-500/30 bg-primary-500/10 px-4 py-3 text-sm">
      <a :href="validatorLink" target="_blank" rel="noopener noreferrer" class="text-primary-300 underline">
        {{ t('share.resources.openValidator') }}
      </a>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="resources.length === 0"
      :title="t('share.resources.empty')"
      :message="t('share.resources.emptyHint')"
    />

    <ul v-else class="space-y-2" data-testid="resource-list">
      <li
        v-for="resource in resources"
        :key="resource.id"
        data-testid="resource-row"
        class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-surface-700/40 bg-surface-900/40 px-4 py-3"
      >
        <SchemeIcon
          :icon="schemeByName.get(resource.scheme)?.icon"
          :scheme="resource.scheme"
        />
        <div class="min-w-0 flex-1 basis-60">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p class="font-medium text-surface-100 truncate">{{ resource.displayName }}</p>
            <BaseBadge :variant="statusVariant(resource.status)" dot>
              {{ t(`share.resourceStatuses.${resource.status}`) }}
            </BaseBadge>
          </div>
          <p class="font-mono text-xs text-surface-500 truncate">{{ resource.uri }}</p>
          <p v-if="!scheme" class="text-[11px] text-surface-600">
            {{ resource.schemeDisplayName ?? resource.scheme }} · {{ resource.applicationName }}
          </p>
          <p v-if="resource.validationError" class="text-[11px] text-red-400 mt-1">
            {{ resource.validationError }}
          </p>
          <p
            v-if="resource.status === 'pending_validation' && awaitsPlatformValidation(resource)"
            class="text-[11px] text-surface-500 mt-1"
          >
            {{ t('share.resources.gatewayHint') }}
          </p>
        </div>
        <span class="hidden xl:block text-xs text-surface-500 shrink-0">
          {{ formatDateTime(resource.updatedAt) }}
        </span>
        <div v-if="canManage" class="flex items-center gap-1 shrink-0">
          <BaseButton
            v-if="resource.scheme === 'ssh'"
            variant="ghost"
            size="sm"
            @click="sshResource = resource"
          >
            <Terminal class="w-3.5 h-3.5" />{{ t('share.ssh.configure') }}
          </BaseButton>
          <BaseButton
            v-else-if="(resource.status === 'pending_validation' || resource.status === 'validation_failed') && !awaitsPlatformValidation(resource)"
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
            v-if="neverValidated(resource) || resource.status !== 'disabled'"
            variant="ghost"
            size="sm"
            @click="requestDisable(resource)"
          >
            <component :is="neverValidated(resource) ? Trash2 : PowerOff" class="w-3.5 h-3.5" />
            {{ neverValidated(resource) ? t('common.delete') : t('share.resources.disable') }}
          </BaseButton>
        </div>
      </li>
    </ul>

    <ResourceFormModal
      :open="showForm"
      :audience-enabled="scope === 'mine'"
      :is-app-admin="appAdmin === true"
      :app-id="appId"
      :schemes="schemes"
      :fixed-scheme="scheme"
      :editing="editing"
      :saving="saving"
      :error="formError"
      @close="showForm = false"
      @submit="save"
    />

    <SshTargetDialog
      v-if="sshResource"
      :open="sshResource !== null"
      :resource-id="sshResource.id"
      :resource-name="sshResource.displayName"
      @close="sshResource = null"
      @updated="load().then(() => emit('changed'))"
    />

    <ConfirmDialog
      :open="showDisable"
      :title="selected && neverValidated(selected) ? t('share.resources.deleteTitle') : t('share.resources.disableTitle')"
      :message="selected && neverValidated(selected) ? t('share.resources.deleteMessage') : t('share.resources.disableMessage')"
      :confirm-label="selected && neverValidated(selected) ? t('common.delete') : t('share.resources.disable')"
      :loading="disabling"
      @confirm="disable"
      @cancel="showDisable = false"
    />
  </div>
</template>
