<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Pencil, ShieldOff } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  listGrants,
  listOwnerPlans,
  listSharedResources,
  revokeGrant,
  updateGrant,
  type OwnerPlan,
  type ResourceGrant,
  type SharedResource,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime, splitList, toIso, toLocalInput } from './format';

const props = defineProps<{
  appId: string;
  canManage: boolean;
}>();

const { t } = useI18n();
const toast = useToast();

const grants = ref<ResourceGrant[]>([]);
const plans = ref<OwnerPlan[]>([]);
const resources = ref<SharedResource[]>([]);
const loading = ref(true);
const saving = ref(false);
const revoking = ref(false);
const showForm = ref(false);
const showRevoke = ref(false);
const editing = ref<ResourceGrant | null>(null);
const selected = ref<ResourceGrant | null>(null);

const form = reactive({
  planId: '',
  resourceId: '',
  expiresAt: '',
  allowedClientIds: '',
});

const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((plan) => ({ value: plan.id, label: plan.name })),
);
const resourceOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('share.grants.allResources') },
  ...resources.value.map((resource) => ({ value: resource.id, label: resource.displayName })),
]);

async function load() {
  loading.value = true;
  try {
    const [grantRes, planRes, resourceRes] = await Promise.all([
      listGrants(props.appId),
      props.canManage ? listOwnerPlans(props.appId) : Promise.resolve({ plans: [] }),
      props.canManage ? listSharedResources(props.appId) : Promise.resolve({ resources: [] }),
    ]);
    grants.value = grantRes.grants;
    plans.value = planRes.plans;
    resources.value = resourceRes.resources;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openEdit(grant: ResourceGrant) {
  editing.value = grant;
  Object.assign(form, {
    planId: grant.planId,
    resourceId: grant.resourceId ?? '',
    expiresAt: toLocalInput(grant.expiresAt),
    allowedClientIds: grant.allowedClientIds?.join(', ') ?? '',
  });
  showForm.value = true;
}

async function save() {
  if (!editing.value) return;
  saving.value = true;
  try {
    const clients = splitList(form.allowedClientIds);
    await updateGrant(props.appId, editing.value.id, {
      planId: form.planId || undefined,
      resourceId: form.resourceId || null,
      expiresAt: form.expiresAt ? toIso(form.expiresAt) ?? null : null,
      allowedClientIds: clients.length > 0 ? clients : null,
    });
    toast.success(t('share.grants.saved'));
    showForm.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

function requestRevoke(grant: ResourceGrant) {
  selected.value = grant;
  showRevoke.value = true;
}

async function revoke() {
  if (!selected.value) return;
  revoking.value = true;
  try {
    await revokeGrant(props.appId, selected.value.id);
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
    <p class="text-sm text-surface-400">{{ t('share.grants.hint') }}</p>

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
            <th class="text-left font-medium px-4 py-3">{{ t('share.grants.subject') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.grants.plan') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.grants.scope') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden xl:table-cell">{{ t('share.grants.clients') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.grants.expires') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
            <th class="px-4 py-3 text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="grant in grants" :key="grant.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3 font-mono text-xs text-surface-300 break-all">{{ grant.subjectId }}</td>
            <td class="px-4 py-3 text-surface-300">{{ grant.planName }}</td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden lg:table-cell">
              {{ grant.resourceId ? resources.find((r) => r.id === grant.resourceId)?.displayName ?? grant.resourceId : t('share.grants.allResources') }}
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden xl:table-cell">
              {{ grant.allowedClientIds?.join(', ') ?? t('share.grants.allClients') }}
            </td>
            <td class="px-4 py-3 text-xs text-surface-500">{{ grant.expiresAt ? formatDateTime(grant.expiresAt) : '—' }}</td>
            <td class="px-4 py-3">
              <BaseBadge :variant="grant.revokedAt ? 'neutral' : 'success'" dot>
                {{ grant.revokedAt ? t('share.grants.revoked') : t('share.grants.active') }}
              </BaseBadge>
            </td>
            <td class="px-4 py-3">
              <div v-if="canManage && !grant.revokedAt" class="flex justify-end gap-1">
                <BaseButton variant="ghost" size="sm" @click="openEdit(grant)">
                  <Pencil class="w-3.5 h-3.5" />{{ t('common.edit') }}
                </BaseButton>
                <BaseButton variant="ghost" size="sm" @click="requestRevoke(grant)">
                  <ShieldOff class="w-3.5 h-3.5" />{{ t('share.grants.revoke') }}
                </BaseButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BaseModal :open="showForm" :title="t('share.grants.editTitle')" size="md" @close="showForm = false">
      <div class="space-y-4">
        <BaseSelect v-model="form.planId" :label="t('share.grants.plan')" :options="planOptions" />
        <BaseSelect v-model="form.resourceId" :label="t('share.grants.scope')" :options="resourceOptions" />
        <BaseInput v-model="form.expiresAt" type="datetime-local" :label="t('share.grants.expiresAt')" />
        <BaseInput
          v-model="form.allowedClientIds"
          :label="t('share.grants.clients')"
          :hint="t('share.grants.clientsHint')"
        />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!form.planId" @click="save">{{ t('common.save') }}</BaseButton>
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
