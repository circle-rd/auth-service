<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, X } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import {
  createInvitation,
  listAppResources,
  listInvitations,
  revokeInvitation,
  type Resource,
  type ResourceInvitation,
} from '@/api/resources';
import type { SelectOption } from '@/types/select';
import { formatDateTime } from './format';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();
const auth = useAuthStore();

const invitations = ref<ResourceInvitation[]>([]);
const resources = ref<Resource[]>([]);
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
  resourceId: '',
  ttlHours: 72,
});

// Only whoever may grant a resource can invite to it: never an administrator
// on someone else's personal resource.
const invitable = computed(() =>
  resources.value.filter(
    (resource) => resource.ownerType === 'application' || resource.ownerId === auth.user?.id,
  ),
);
const resourceOptions = computed<SelectOption[]>(() =>
  invitable.value.map((resource) => ({
    value: resource.id,
    label: resource.displayName,
    description: resource.uri,
  })),
);
const canSave = computed(
  () => form.email.trim().length > 0 && form.resourceId.length > 0,
);

function stateVariant(state: ResourceInvitation['state']): 'success' | 'warning' | 'neutral' {
  if (state === 'pending') return 'warning';
  if (state === 'consumed') return 'success';
  return 'neutral';
}

async function load() {
  loading.value = true;
  try {
    const [invitationRes, resourceRes] = await Promise.all([
      listInvitations(props.appId),
      listAppResources(props.appId),
    ]);
    invitations.value = invitationRes.invitations;
    resources.value = resourceRes.resources;
    if (!form.resourceId && invitable.value[0]) form.resourceId = invitable.value[0].id;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, {
    email: '',
    resourceId: invitable.value[0]?.id ?? '',
    ttlHours: 72,
  });
  inviteUrl.value = '';
  emailSent.value = false;
  showForm.value = true;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const result = await createInvitation(props.appId, {
      email: form.email.trim(),
      resourceId: form.resourceId,
      ttlHours: form.ttlHours,
    });
    inviteUrl.value = result.inviteUrl;
    emailSent.value = result.emailSent;
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
      <BaseButton size="sm" @click="openCreate">
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
            <th class="text-left font-medium px-4 py-3">{{ t('share.invitations.resource') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden lg:table-cell">{{ t('share.invitations.expires') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
            <th class="px-4 py-3 text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="invitation in invitations" :key="invitation.id" class="border-t border-surface-800/60">
            <td class="px-4 py-3 text-surface-200">{{ invitation.email }}</td>
            <td class="px-4 py-3">
              <p class="text-surface-300">{{ invitation.resourceDisplayName ?? invitation.resourceId }}</p>
              <p class="font-mono text-[11px] text-surface-500 break-all">{{ invitation.resourceUri }}</p>
            </td>
            <td class="px-4 py-3 text-xs text-surface-500 hidden lg:table-cell">
              {{ formatDateTime(invitation.expiresAt) }}
            </td>
            <td class="px-4 py-3">
              <BaseBadge :variant="stateVariant(invitation.state)" dot>
                {{ t(`share.invitationStates.${invitation.state}`) }}
              </BaseBadge>
            </td>
            <td class="px-4 py-3">
              <div v-if="invitation.state === 'pending'" class="flex justify-end">
                <BaseButton variant="ghost" size="sm" @click="requestRevoke(invitation)">
                  <X class="w-3.5 h-3.5" />{{ t('share.invitations.revoke') }}
                </BaseButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BaseModal :open="showForm" :title="t('share.invitations.createTitle')" size="md" @close="showForm = false">
      <div class="space-y-4">
        <BaseInput v-model="form.email" type="email" :label="t('share.invitations.email')" required />
        <BaseSelect v-model="form.resourceId" :label="t('share.invitations.resource')" :options="resourceOptions" />
        <BaseInput v-model.number="form.ttlHours" type="number" :label="t('share.invitations.ttlHours')" />
        <div v-if="inviteUrl" class="rounded-xl bg-surface-800/60 p-3 space-y-1">
          <p class="text-xs text-surface-400">{{ t('share.invitations.urlOnce') }}</p>
          <p class="font-mono text-xs text-primary-300 break-all">{{ inviteUrl }}</p>
          <p class="text-xs text-surface-500">
            {{ emailSent ? t('share.invitations.sent') : t('share.invitations.notSent') }}
          </p>
        </div>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.close') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!canSave" @click="save">{{ t('common.create') }}</BaseButton>
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
