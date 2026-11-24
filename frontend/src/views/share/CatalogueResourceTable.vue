<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ExternalLink, Pencil, Plus, PowerOff, RefreshCw, Share2, Terminal, Trash2 } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import DataTable from '@/components/ui/DataTable.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import {
  createResource,
  removeResource,
  requestValidation,
  updateResource,
  type AccessibleResource,
  type Resource,
  type ResourceGrant,
  type ResourceScheme,
} from '@/api/resources';
import type { ColumnDef } from '@/types/data-table';
import { formatDateTime } from './format';
import ResourceFormModal, { type ResourceFormPayload } from './ResourceFormModal.vue';
import ResourceGrantModal from './ResourceGrantModal.vue';
import SshTargetDialog from './SshTargetDialog.vue';

interface Row extends Record<string, unknown> {
  key: string;
  kind: 'owner' | 'grant';
  resource: Resource | null;
  accessible: AccessibleResource | null;
  name: string;
  uri: string;
  status: string;
  grants: ResourceGrant[];
  accessLabel: string;
  updatedAt: string | null;
  searchable: string;
}

const props = defineProps<{
  appId: string;
  scheme: ResourceScheme;
  mine: Resource[];
  shared: AccessibleResource[];
  canCreate: boolean;
  appAdmin: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();
const toast = useToast();
const auth = useAuthStore();

const search = ref('');
const accessFilter = ref<'all' | 'owner' | 'grant'>('all');
const page = ref(1);
const limit = ref(20);

const formOpen = ref(false);
const formError = ref('');
const saving = ref(false);
const editing = ref<Resource | null>(null);
const grantResource = ref<Resource | null>(null);
const sshResource = ref<Resource | null>(null);
const disabling = ref(false);
const showDisable = ref(false);
const selected = ref<Resource | null>(null);
const validatorLink = ref<string | null>(null);

function grantLabel(grant: ResourceGrant): string {
  if (grant.subjectType === 'everyone') return t('share.grants.everyone');
  return grant.subjectLabel || grant.subjectId || '—';
}

function activeGrants(resource: Resource): ResourceGrant[] {
  return (resource.grants ?? []).filter((grant) => !grant.revokedAt);
}

const rows = computed<Row[]>(() => {
  const mineIds = new Set(props.mine.map((resource) => resource.id));
  const owned: Row[] = props.mine.map((resource) => {
    const grants = activeGrants(resource);
    return {
      key: `owner:${resource.id}`,
      kind: 'owner',
      resource,
      accessible: null,
      name: resource.displayName,
      uri: resource.uri,
      status: resource.status,
      grants,
      accessLabel: t('share.catalogue.accessOwner'),
      updatedAt: resource.updatedAt,
      searchable: [resource.displayName, resource.uri, ...grants.map(grantLabel)].join(' ').toLowerCase(),
    };
  });
  const shared: Row[] = props.shared
    .filter((item) => !mineIds.has(item.resourceId) && item.accessKind !== 'owner')
    .map((item) => ({
      key: `grant:${item.resourceId}`,
      kind: 'grant',
      resource: null,
      accessible: item,
      name: item.displayName,
      uri: item.resourceUri,
      status: 'validated',
      grants: [],
      accessLabel: t(`share.subjectTypes.${item.grantSubjectType ?? 'user'}`),
      updatedAt: null,
      searchable: [item.displayName, item.resourceUri, item.grantSubjectType ?? ''].join(' ').toLowerCase(),
    }));
  return [...owned, ...shared];
});

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (accessFilter.value !== 'all' && row.kind !== accessFilter.value) return false;
    return query.length === 0 || row.searchable.includes(query);
  });
});

const pagination = computed(() => ({ page: page.value, limit: limit.value, total: filtered.value.length }));

watch([search, accessFilter], () => {
  page.value = 1;
});

const columns = computed<ColumnDef<Row>[]>(() => [
  { key: 'resource', label: t('share.grants.resource'), sortable: true, accessor: (row) => row.name },
  { key: 'access', label: t('share.catalogue.access'), sortable: true, accessor: (row) => row.accessLabel },
  { key: 'status', label: t('common.status'), sortable: true, accessor: (row) => row.status },
  { key: 'sharing', label: t('share.catalogue.sharedWith'), responsive: 'lg' },
  { key: 'updated', label: t('share.catalogue.updated'), sortable: true, responsive: 'xl', accessor: (row) => row.updatedAt },
  { key: 'actions', label: '', align: 'right' },
]);

const accessOptions = computed(() => [
  { value: 'all', label: t('share.catalogue.filterAll') },
  { value: 'owner', label: t('share.catalogue.accessOwner') },
  { value: 'grant', label: t('share.catalogue.sharedWithMe') },
]);

function awaitsPlatformValidation(): boolean {
  return props.scheme.adapter === 'litellm' && !auth.isAdmin();
}

function statusVariant(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'validated') return 'success';
  if (status === 'pending_validation' || status === 'validation_failed') return 'warning';
  return 'neutral';
}

function openCreate() {
  editing.value = null;
  formError.value = '';
  formOpen.value = true;
}

function openEdit(resource: Resource) {
  editing.value = resource;
  formError.value = '';
  formOpen.value = true;
}

async function save(form: ResourceFormPayload) {
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      await updateResource(editing.value.id, { displayName: form.displayName });
      toast.success(t('share.resources.saved'));
    } else {
      await createResource({
        applicationId: props.appId,
        scheme: form.scheme,
        displayName: form.displayName,
        locator: form.locator,
        audience: form.audience,
      });
      toast.success(t('share.resources.created'));
    }
    formOpen.value = false;
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
      validatorLink.value = `${result.validatorUrl}${separator}resourceId=${resource.id}`;
    }
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

function requestDisable(resource: Resource) {
  selected.value = resource;
  showDisable.value = true;
}

function neverValidated(resource: Resource): boolean {
  return resource.validatedAt === null;
}

async function disable() {
  if (!selected.value) return;
  disabling.value = true;
  try {
    await removeResource(selected.value.id);
    toast.success(t('share.resources.deletedToast'));
    showDisable.value = false;
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    disabling.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-surface-400">{{ t('share.catalogue.type.tableHint') }}</p>
      <BaseButton v-if="canCreate" size="sm" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.resources.add') }}
      </BaseButton>
    </div>

    <div v-if="validatorLink" class="rounded-xl border border-primary-500/30 bg-primary-500/10 px-4 py-3 text-sm">
      <a :href="validatorLink" target="_blank" rel="noopener noreferrer" class="text-primary-300 underline">
        {{ t('share.resources.openValidator') }}
      </a>
    </div>

    <DataTable
      v-model:search="search"
      :columns="columns"
      :items="filtered"
      :row-key="(row: Row) => row.key"
      :pagination="pagination"
      paginate-locally
      searchable
      :search-placeholder="t('share.catalogue.searchPlaceholder')"
      :empty="filtered.length === 0"
      @update:page="page = $event"
      @update:limit="(next: number) => { limit = next; page = 1; }"
    >
      <template #filters>
        <BaseSelect
          :model-value="accessFilter"
          :options="accessOptions"
          size="sm"
          class="w-44"
          @update:model-value="(value: string) => accessFilter = value as 'all' | 'owner' | 'grant'"
        />
      </template>

      <template #cell-resource="{ row }: { row: Row }">
        <div class="flex items-center gap-3 min-w-0">
          <SchemeIcon :icon="scheme.icon" :scheme="scheme.scheme" size="sm" />
          <div class="min-w-0">
            <p class="font-medium text-surface-100 truncate">{{ row.name }}</p>
            <p class="font-mono text-[11px] text-surface-500 truncate">{{ row.uri }}</p>
          </div>
        </div>
      </template>

      <template #cell-access="{ row }: { row: Row }">
        <BaseBadge :variant="row.kind === 'owner' ? 'primary' : 'neutral'">
          {{ row.accessLabel }}
        </BaseBadge>
      </template>

      <template #cell-status="{ row }: { row: Row }">
        <BaseBadge :variant="statusVariant(row.status)" dot>
          {{ t(`share.resourceStatuses.${row.status}`) }}
        </BaseBadge>
      </template>

      <template #cell-sharing="{ row }: { row: Row }">
        <div v-if="row.kind === 'owner'" class="flex flex-wrap gap-1">
          <template v-if="row.grants.length > 0">
            <BaseBadge
              v-for="grant in row.grants.slice(0, 2)"
              :key="grant.id"
              variant="neutral"
              size="sm"
            >
              {{ grantLabel(grant) }}
            </BaseBadge>
            <BaseBadge v-if="row.grants.length > 2" variant="neutral" size="sm">
              +{{ row.grants.length - 2 }}
            </BaseBadge>
          </template>
          <span v-else class="text-xs text-surface-500">{{ t('share.catalogue.private') }}</span>
        </div>
        <span v-else class="text-xs text-surface-500">{{ row.accessLabel }}</span>
      </template>

      <template #cell-updated="{ row }: { row: Row }">
        <span class="text-xs text-surface-500">{{ row.updatedAt ? formatDateTime(row.updatedAt) : '—' }}</span>
      </template>

      <template #cell-actions="{ row }: { row: Row }">
        <div v-if="row.kind === 'owner' && row.resource" class="flex items-center justify-end gap-1">
          <BaseButton variant="ghost" size="sm" :title="t('share.grants.manage')" @click="grantResource = row.resource">
            <Share2 class="w-3.5 h-3.5" />
          </BaseButton>
          <BaseButton
            v-if="row.resource.scheme === 'ssh'"
            variant="ghost"
            size="sm"
            :title="t('share.ssh.configure')"
            @click="sshResource = row.resource"
          >
            <Terminal class="w-3.5 h-3.5" />
          </BaseButton>
          <BaseButton
            v-else-if="(row.resource.status === 'pending_validation' || row.resource.status === 'validation_failed') && !awaitsPlatformValidation()"
            variant="ghost"
            size="sm"
            :title="t('share.resources.validate')"
            @click="validate(row.resource)"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <ExternalLink v-if="row.resource.status === 'pending_validation'" class="w-3 h-3" />
          </BaseButton>
          <BaseButton variant="ghost" size="sm" :title="t('common.edit')" @click="openEdit(row.resource)">
            <Pencil class="w-3.5 h-3.5" />
          </BaseButton>
          <BaseButton
            variant="ghost"
            size="sm"
            :title="neverValidated(row.resource) ? t('common.delete') : t('share.resources.disable')"
            @click="requestDisable(row.resource)"
          >
            <component :is="neverValidated(row.resource) ? Trash2 : PowerOff" class="w-3.5 h-3.5" />
          </BaseButton>
        </div>
        <span v-else class="text-xs text-surface-600">—</span>
      </template>

      <template #empty>
        <div class="py-10 text-center text-sm text-surface-500">
          {{ search || accessFilter !== 'all' ? t('share.catalogue.noMatch') : t('share.catalogue.type.tableEmpty') }}
        </div>
      </template>
    </DataTable>

    <ResourceFormModal
      :open="formOpen"
      :app-id="appId"
      :schemes="[scheme]"
      :fixed-scheme="scheme.scheme"
      :editing="editing"
      :saving="saving"
      :error="formError"
      audience-enabled
      :is-app-admin="appAdmin"
      @close="formOpen = false"
      @submit="save"
    />

    <ResourceGrantModal
      :open="grantResource !== null"
      :resource="grantResource"
      :app-id="appId"
      :is-admin="appAdmin"
      @close="grantResource = null"
      @changed="emit('changed')"
    />

    <SshTargetDialog
      v-if="sshResource"
      :open="sshResource !== null"
      :resource-id="sshResource.id"
      :resource-name="sshResource.displayName"
      @close="sshResource = null"
      @updated="emit('changed')"
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
