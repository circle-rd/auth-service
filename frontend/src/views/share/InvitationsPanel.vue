<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Ban } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import CopyField from '@/components/ui/CopyField.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  createInvitation,
  listInvitations,
  listOwnerPlans,
  listSharedResources,
  revokeInvitation,
  type OwnerPlan,
  type ResourceInvitation,
  type SharedResource,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime, splitList, statusVariant } from './format';

const props = defineProps<{
  appId: string;
  canManage: boolean;
}>();

const { t } = useI18n();
const toast = useToast();

const invitations = ref<ResourceInvitation[]>([]);
const plans = ref<OwnerPlan[]>([]);
const resources = ref<SharedResource[]>([]);
const loading = ref(true);
const saving = ref(false);
const revoking = ref(false);
const showForm = ref(false);
const showRevoke = ref(false);
const selected = ref<ResourceInvitation | null>(null);
const inviteUrl = ref('');
const emailSent = ref(false);

const form = reactive({
  email: '',
  planId: '',
  resourceId: '',
  allowedClientIds: '',
  ttlHours: '72',
});

const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((plan) => ({ value: plan.id, label: plan.name })),
);
const resourceOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('share.invitations.allResources') },
  ...resources.value.map((resource) => ({ value: resource.id, label: resource.displayName })),
]);

async function load() {
  loading.value = true;
  try {
    const [invitationRes, planRes, resourceRes] = await Promise.all([
      listInvitations(props.appId),
      listOwnerPlans(props.appId),
      listSharedResources(props.appId),
    ]);
    invitations.value = invitationRes.invitations;
    plans.value = planRes.plans;
    resources.value = resourceRes.resources;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, {
    email: '',
    planId: plans.value.find((plan) => plan.isDefault)?.id ?? plans.value[0]?.id ?? '',
    resourceId: '',
    allowedClientIds: '',
    ttlHours: '72',
  });
  inviteUrl.value = '';
  emailSent.value = false;
  showForm.value = true;
}

async function save() {
  saving.value = true;
  try {
    const clients = splitList(form.allowedClientIds);
    const ttl = Number(form.ttlHours);
    const res = await createInvitation(props.appId, {
      email: form.email.trim(),
      planId: form.planId,
      resourceId: form.resourceId || null,
      allowedClientIds: clients.length > 0 ? clients : null,
      ttlHours: Number.isInteger(ttl) && ttl > 0 ? ttl : undefined,
    });
    inviteUrl.value = res.inviteUrl;
    emailSent.value = res.emailSent;
    toast.success(t('share.invitations.created'));
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

function requestRevoke(invitation: ResourceInvitation) {
  selected.value = invitation;
  showRevoke.value = true;
}

async function revoke() {
  if (!selected.value) return;
  revoking.value = true;
  try {
    await revokeInvitation(props.appId, selected.value.id);
    toast.success(t('share.invitations.revokedToast'));
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
      <p class="text-sm text-surface-400">{{ t('share.invitations.hint') }}</p>
      <BaseButton v-if="canManage" size="sm" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.invitations.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="invitations.length === 0"
      :title="t('share.invitations.empty')"
      :message="t('share.invitations.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.invitations.email') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.invitations.plan') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.invitations.resource') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden xl:table-cell">{{ t('share.invitations.expires') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
            <th class="px-4 py-3 text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="invitation in invitations" :key="invitation.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3 text-surface-300">{{ invitation.email }}</td>
            <td class="px-4 py-3 text-surface-300">{{ invitation.planName }}</td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden lg:table-cell">
              {{ invitation.resourceName ?? t('share.invitations.allResources') }}
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden xl:table-cell">
              {{ formatDateTime(invitation.expiresAt) }}
            </td>
            <td class="px-4 py-3">
              <BaseBadge :variant="statusVariant(invitation.state)" dot>
                {{ t(`share.invitationStates.${invitation.state}`) }}
              </BaseBadge>
            </td>
            <td class="px-4 py-3">
              <div v-if="canManage && invitation.state === 'pending'" class="flex justify-end">
                <BaseButton variant="ghost" size="sm" @click="requestRevoke(invitation)">
                  <Ban class="w-3.5 h-3.5" />{{ t('share.invitations.revoke') }}
                </BaseButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BaseModal :open="showForm" :title="t('share.invitations.createTitle')" size="md" @close="showForm = false">
      <div v-if="inviteUrl" class="space-y-4">
        <p class="text-sm text-surface-300">
          {{ emailSent ? t('share.invitations.sent') : t('share.invitations.notSent') }}
        </p>
        <CopyField :value="inviteUrl" :label="t('share.invitations.acceptanceUrl')" />
        <p class="text-xs text-surface-500">{{ t('share.invitations.urlOnce') }}</p>
        <BaseButton @click="showForm = false">{{ t('common.close') }}</BaseButton>
      </div>
      <div v-else class="space-y-4">
        <BaseInput v-model="form.email" type="email" :label="t('share.invitations.email')" required />
        <BaseSelect v-model="form.planId" :label="t('share.invitations.plan')" :options="planOptions" />
        <BaseSelect v-model="form.resourceId" :label="t('share.invitations.resource')" :options="resourceOptions" />
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BaseInput v-model="form.allowedClientIds" :label="t('share.invitations.clients')" :hint="t('share.grants.clientsHint')" />
          <BaseInput v-model="form.ttlHours" type="number" :label="t('share.invitations.ttlHours')" />
        </div>
      </div>
      <template v-if="!inviteUrl" #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!form.email || !form.planId" @click="save">
          {{ t('share.invitations.add') }}
        </BaseButton>
      </template>
    </BaseModal>

    <ConfirmDialog
      :open="showRevoke"
      :title="t('share.invitations.revokeTitle')"
      :message="t('share.invitations.revokeMessage')"
      :confirm-label="t('share.invitations.revoke')"
      :loading="revoking"
      @confirm="revoke"
      @cancel="showRevoke = false"
    />
  </div>
</template>
