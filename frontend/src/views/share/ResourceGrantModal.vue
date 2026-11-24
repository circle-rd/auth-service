<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldOff, Trash2 } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { useToast } from '@/composables/useToast';
import { getMyOrganizations } from '@/api/organizations';
import {
  createGrant,
  deleteGrant,
  listOwnerPlans,
  listResourceGrants,
  revokeGrant,
  updateGrantPermission,
  RESOURCE_SUBJECT_TYPES,
  type OwnerPlan,
  type Resource,
  type ResourceGrant,
  type ResourcePermission,
  type ResourceSubjectType,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime, toIso } from './format';

const props = defineProps<{
  open: boolean;
  resource: Resource | null;
  appId: string;
  isAdmin: boolean;
}>();

const emit = defineEmits<{ close: []; changed: [] }>();

const { t } = useI18n();
const toast = useToast();

const grants = ref<ResourceGrant[]>([]);
const plans = ref<OwnerPlan[]>([]);
const organizations = ref<Array<{ id: string; name: string }>>([]);
const loading = ref(false);
const saving = ref(false);
const revoking = ref(false);
const error = ref('');
const selected = ref<ResourceGrant | null>(null);
const showRevoke = ref(false);
const showDelete = ref(false);
const deleting = ref(false);

const form = reactive({
  subjectType: 'user' as ResourceSubjectType,
  email: '',
  organizationId: '',
  planId: '',
  applicationSlug: '',
  permission: 'read' as ResourcePermission,
  expiresAt: '',
});

function isActive(grant: ResourceGrant): boolean {
  if (grant.revokedAt) return false;
  return !grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now();
}

const activeGrants = computed(() => grants.value.filter(isActive));
// Revoked or expired grants stay listed until they are deleted or swept.
const pastGrants = computed(() => grants.value.filter((grant) => !isActive(grant)));

// The levels this resource type supports; a single-action type has only `read`.
const levels = computed<ResourcePermission[]>(() => props.resource?.permissions ?? ['read']);
const levelOptions = computed<SelectOption[]>(() =>
  levels.value.map((value) => ({ value, label: t(`share.permissions.${value}`) })),
);

const allowedTypes = computed<ResourceSubjectType[]>(() => {
  // A personal resource is shared with members or with an organization the
  // owner belongs to; plans and everyone stay reserved to application admins.
  if (props.resource?.ownerType === 'user' && !props.isAdmin) {
    return RESOURCE_SUBJECT_TYPES.filter((type) => type === 'user' || type === 'organization');
  }
  return [...RESOURCE_SUBJECT_TYPES];
});

const typeOptions = computed<SelectOption[]>(() =>
  allowedTypes.value.map((value) => ({ value, label: t(`share.subjectTypes.${value}`) })),
);
const organizationOptions = computed<SelectOption[]>(() =>
  organizations.value.map((org) => ({ value: org.id, label: org.name })),
);
const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((plan) => ({ value: plan.id, label: plan.name, description: plan.description ?? undefined })),
);

const canSave = computed(() => {
  if (!props.resource) return false;
  if (form.subjectType === 'everyone') return true;
  if (form.subjectType === 'user') return form.email.trim().length > 0;
  if (form.subjectType === 'organization') return form.organizationId.length > 0;
  if (form.subjectType === 'application') return form.applicationSlug.trim().length > 0;
  return form.planId.length > 0;
});

function subjectLabel(grant: ResourceGrant): string {
  if (grant.subjectType === 'everyone') return t('share.grants.everyone');
  return grant.subjectLabel || grant.subjectId || '—';
}

async function load() {
  if (!props.resource) return;
  loading.value = true;
  error.value = '';
  try {
    const [grantRes, orgRes] = await Promise.all([
      listResourceGrants(props.resource.id),
      getMyOrganizations(),
    ]);
    grants.value = grantRes.grants;
    organizations.value = orgRes.organizations.map((org) => ({ id: org.id, name: org.name }));
    if (props.isAdmin) {
      plans.value = (await listOwnerPlans(props.appId)).plans;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('share.loadError');
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  form.subjectType = allowedTypes.value[0] ?? 'user';
  form.email = '';
  form.organizationId = '';
  form.planId = '';
  form.applicationSlug = '';
  form.permission = 'read';
  form.expiresAt = '';
}

watch(
  () => [props.open, props.resource?.id],
  ([open]) => {
    if (open) {
      resetForm();
      void load();
    }
  },
  { immediate: true },
);

async function save() {
  if (!props.resource || !canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    await createGrant(props.resource.id, {
      subjectType: form.subjectType,
      subjectEmail: form.subjectType === 'user' ? form.email.trim() : null,
      subjectId:
        form.subjectType === 'organization'
          ? form.organizationId
          : form.subjectType === 'plan'
            ? form.planId
            : form.subjectType === 'application'
              ? form.applicationSlug.trim()
              : null,
      permission: form.permission,
      expiresAt: form.expiresAt ? toIso(form.expiresAt) ?? null : null,
    });
    toast.success(t('share.grants.created'));
    resetForm();
    await load();
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('share.saveError');
  } finally {
    saving.value = false;
  }
}

async function changeLevel(grant: ResourceGrant) {
  if (!props.resource) return;
  const next: ResourcePermission = grant.permission === 'read' ? 'write' : 'read';
  try {
    await updateGrantPermission(props.resource.id, grant.id, next);
    toast.success(t('share.grants.levelChanged'));
    await load();
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

function requestDelete(grant: ResourceGrant) {
  selected.value = grant;
  showDelete.value = true;
}

async function removeGrant() {
  if (!props.resource || !selected.value) return;
  deleting.value = true;
  try {
    await deleteGrant(props.resource.id, selected.value.id);
    toast.success(t('share.grants.deletedToast'));
    showDelete.value = false;
    await load();
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    deleting.value = false;
  }
}

function requestRevoke(grant: ResourceGrant) {
  selected.value = grant;
  showRevoke.value = true;
}

async function revoke() {
  if (!props.resource || !selected.value) return;
  revoking.value = true;
  try {
    await revokeGrant(props.resource.id, selected.value.id);
    toast.success(t('share.grants.revokedToast'));
    showRevoke.value = false;
    await load();
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    revoking.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('share.grants.manageTitle', { name: resource?.displayName ?? '' })"
    size="lg"
    @close="emit('close')"
  >
    <div class="space-y-5">
      <div v-if="loading" class="h-24 rounded-xl bg-surface-800/40 animate-pulse" />

      <template v-else>
        <div class="space-y-2">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
            {{ t('share.grants.current') }}
          </p>
          <p v-if="activeGrants.length === 0" class="text-sm text-surface-500">
            {{ t('share.grants.privateHint') }}
          </p>
          <ul v-else class="divide-y divide-surface-800/60 rounded-xl border border-surface-700/40">
            <li
              v-for="grant in activeGrants"
              :key="grant.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <BaseBadge variant="neutral">{{ t(`share.subjectTypes.${grant.subjectType}`) }}</BaseBadge>
              <span class="text-sm text-surface-200 min-w-0 flex-1 truncate">{{ subjectLabel(grant) }}</span>
              <BaseBadge v-if="levels.length > 1" :variant="grant.permission === 'write' ? 'warning' : 'neutral'">
                {{ t(`share.permissions.${grant.permission}`) }}
              </BaseBadge>
              <span v-if="grant.expiresAt" class="text-xs text-surface-500">
                {{ formatDateTime(grant.expiresAt) }}
              </span>
              <BaseButton v-if="levels.length > 1" variant="ghost" size="sm" @click="changeLevel(grant)">
                {{ t(grant.permission === 'read' ? 'share.grants.allowWrite' : 'share.grants.makeReadOnly') }}
              </BaseButton>
              <BaseButton variant="ghost" size="sm" @click="requestRevoke(grant)">
                <ShieldOff class="w-3.5 h-3.5" />{{ t('share.grants.revoke') }}
              </BaseButton>
            </li>
          </ul>
        </div>

        <div v-if="pastGrants.length > 0" class="space-y-2">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
            {{ t('share.grants.past') }}
          </p>
          <ul class="divide-y divide-surface-800/60 rounded-xl border border-surface-700/40">
            <li
              v-for="grant in pastGrants"
              :key="grant.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <BaseBadge variant="neutral">{{ t(`share.subjectTypes.${grant.subjectType}`) }}</BaseBadge>
              <span class="text-sm text-surface-400 min-w-0 flex-1 truncate">{{ subjectLabel(grant) }}</span>
              <BaseBadge variant="neutral">
                {{ t(grant.revokedAt ? 'share.grants.revoked' : 'share.grants.expired') }}
              </BaseBadge>
              <BaseButton variant="ghost" size="sm" @click="requestDelete(grant)">
                <Trash2 class="w-3.5 h-3.5" />{{ t('share.grants.deleteForGood') }}
              </BaseButton>
            </li>
          </ul>
        </div>

        <div class="space-y-3 border-t border-surface-800/60 pt-4">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
            {{ t('share.grants.add') }}
          </p>
          <BaseSelect v-model="form.subjectType" :label="t('share.grants.subjectType')" :options="typeOptions" />
          <BaseInput
            v-if="form.subjectType === 'user'"
            v-model="form.email"
            type="email"
            :label="t('share.subjectTypes.user')"
            :hint="t('share.grants.subjectEmailHint')"
            placeholder="colleague@example.com"
          />
          <BaseSelect
            v-else-if="form.subjectType === 'organization'"
            v-model="form.organizationId"
            :label="t('share.subjectTypes.organization')"
            :options="organizationOptions"
            :placeholder="organizationOptions.length ? undefined : t('share.grants.noOrganization')"
          />
          <BaseSelect
            v-else-if="form.subjectType === 'plan'"
            v-model="form.planId"
            :label="t('share.subjectTypes.plan')"
            :options="planOptions"
          />
          <BaseInput
            v-else-if="form.subjectType === 'application'"
            v-model="form.applicationSlug"
            :label="t('share.subjectTypes.application')"
            :hint="t('share.grants.applicationHint')"
            placeholder="application-slug"
          />
          <BaseSelect
            v-if="levels.length > 1"
            v-model="form.permission"
            :label="t('share.grants.permission')"
            :options="levelOptions"
          />
          <BaseInput v-model="form.expiresAt" type="datetime-local" :label="t('share.grants.expiresAt')" />
          <p v-if="error" role="alert" class="text-xs text-red-400">{{ error }}</p>
        </div>
      </template>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.close') }}</BaseButton>
      <BaseButton :loading="saving" :disabled="!canSave" @click="save">
        {{ t('share.grants.share') }}
      </BaseButton>
    </template>
  </BaseModal>

  <ConfirmDialog
    :open="showRevoke"
    :title="t('share.grants.revokeTitle')"
    :message="t('share.grants.revokeMessage')"
    :confirm-label="t('share.grants.revoke')"
    :loading="revoking"
    @confirm="revoke"
    @cancel="showRevoke = false"
  />

  <ConfirmDialog
    :open="showDelete"
    :title="t('share.grants.deleteTitle')"
    :message="t('share.grants.deleteMessage')"
    :confirm-label="t('share.grants.deleteForGood')"
    :loading="deleting"
    @confirm="removeGrant"
    @cancel="showDelete = false"
  />
</template>
