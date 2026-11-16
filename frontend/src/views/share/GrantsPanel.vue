<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, ShieldOff } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  createGrant,
  listAppGrants,
  listAppResources,
  listOwnerPlans,
  revokeGrant,
  RESOURCE_SUBJECT_TYPES,
  type OwnerPlan,
  type Resource,
  type ResourceGrant,
  type ResourceSubjectType,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime, toIso } from './format';

const props = defineProps<{
  appId: string;
  canManage: boolean;
  isAdmin: boolean;
}>();

const { t } = useI18n();
const toast = useToast();

const grants = ref<ResourceGrant[]>([]);
const resources = ref<Resource[]>([]);
const plans = ref<OwnerPlan[]>([]);
const loading = ref(true);
const saving = ref(false);
const revoking = ref(false);
const showForm = ref(false);
const showRevoke = ref(false);
const selected = ref<ResourceGrant | null>(null);

const form = reactive({
  resourceId: '',
  subjectType: 'user' as ResourceSubjectType,
  subjectId: '',
  expiresAt: '',
});

const resourceOptions = computed<SelectOption[]>(() =>
  resources.value.map((resource) => ({
    value: resource.id,
    label: resource.displayName,
    description: resource.uri,
  })),
);
const subjectOptions = computed<SelectOption[]>(() =>
  RESOURCE_SUBJECT_TYPES.filter((value) => props.isAdmin || value === 'user').map((value) => ({
    value,
    label: t(`share.subjectTypes.${value}`),
  })),
);
const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((plan) => ({ value: plan.id, label: plan.name, description: plan.description ?? undefined })),
);
const needsSubjectId = computed(() => form.subjectType !== 'everyone');
const canSave = computed(
  () => form.resourceId.length > 0 && (!needsSubjectId.value || form.subjectId.trim().length > 0),
);

async function load() {
  loading.value = true;
  try {
    const [grantRes, resourceRes, planRes] = await Promise.all([
      listAppGrants(props.appId),
      listAppResources(props.appId),
      listOwnerPlans(props.appId),
    ]);
    grants.value = grantRes.grants;
    resources.value = resourceRes.resources;
    plans.value = planRes.plans;
    if (!form.resourceId && resources.value[0]) form.resourceId = resources.value[0].id;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, {
    resourceId: resources.value[0]?.id ?? '',
    subjectType: 'user',
    subjectId: '',
    expiresAt: '',
  });
  showForm.value = true;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    await createGrant(form.resourceId, {
      subjectType: form.subjectType,
      subjectId: needsSubjectId.value ? form.subjectId.trim() : null,
      expiresAt: form.expiresAt ? toIso(form.expiresAt) ?? null : null,
    });
    toast.success(t('share.grants.created'));
    showForm.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

function isExpired(grant: ResourceGrant): boolean {
  return !grant.revokedAt && grant.expiresAt !== null && new Date(grant.expiresAt).getTime() <= Date.now();
}

function requestRevoke(grant: ResourceGrant) {
  selected.value = grant;
  showRevoke.value = true;
}

async function revoke() {
  if (!selected.value) return;
  revoking.value = true;
  try {
    await revokeGrant(selected.value.resourceId, selected.value.id);
    toast.success(t('share.grants.revokedToast'));
    showRevoke.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    revoking.value = false;
  }
}

watch(() => props.appId, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-surface-400">{{ t('share.grants.hint') }}</p>
      <BaseButton v-if="canManage" size="sm" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.grants.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="grants.length === 0"
      :title="t('share.grants.empty')"
      :message="t('share.grants.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.grants.resource') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.grants.subjectType') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.grants.subject') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.grants.expires') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
            <th class="px-4 py-3 text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="grant in grants" :key="grant.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3">
              <p class="text-surface-200">{{ grant.resourceDisplayName ?? grant.resourceUri ?? grant.resourceId }}</p>
              <p class="font-mono text-[11px] text-surface-500 break-all">{{ grant.resourceUri }}</p>
            </td>
            <td class="px-4 py-3 text-surface-400">{{ t(`share.subjectTypes.${grant.subjectType}`) }}</td>
            <td class="px-4 py-3 font-mono text-xs text-surface-300 break-all">
              {{ grant.subjectId ?? t('share.grants.everyone') }}
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden lg:table-cell">
              {{ grant.expiresAt ? formatDateTime(grant.expiresAt) : '—' }}
            </td>
            <td class="px-4 py-3">
              <BaseBadge :variant="grant.revokedAt || isExpired(grant) ? 'neutral' : 'success'" dot>
                {{ grant.revokedAt ? t('share.grants.revoked') : isExpired(grant) ? t('share.grants.expired') : t('share.grants.active') }}
              </BaseBadge>
            </td>
            <td class="px-4 py-3">
              <div v-if="canManage && !grant.revokedAt" class="flex justify-end gap-1">
                <BaseButton variant="ghost" size="sm" @click="requestRevoke(grant)">
                  <ShieldOff class="w-3.5 h-3.5" />{{ t('share.grants.revoke') }}
                </BaseButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BaseModal :open="showForm" :title="t('share.grants.createTitle')" size="md" @close="showForm = false">
      <div class="space-y-4">
        <BaseSelect v-model="form.resourceId" :label="t('share.grants.resource')" :options="resourceOptions" />
        <BaseSelect v-model="form.subjectType" :label="t('share.grants.subjectType')" :options="subjectOptions" />
        <BaseSelect
          v-if="form.subjectType === 'plan'"
          v-model="form.subjectId"
          :label="t('share.subjectTypes.plan')"
          :options="planOptions"
        />
        <BaseInput
          v-else-if="needsSubjectId"
          v-model="form.subjectId"
          :label="t(`share.subjectTypes.${form.subjectType}`)"
          :hint="t('share.grants.subjectHint')"
          required
        />
        <BaseInput v-model="form.expiresAt" type="datetime-local" :label="t('share.grants.expiresAt')" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!canSave" @click="save">{{ t('common.create') }}</BaseButton>
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
  </div>
</template>
