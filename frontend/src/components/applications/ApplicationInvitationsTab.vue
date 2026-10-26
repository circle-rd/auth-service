<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Mail, Send, Trash2 } from 'lucide-vue-next';
import * as invitationsApi from '@/api/registration-invitations';
import { useToast } from '@/composables/useToast';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import CopyField from '@/components/ui/CopyField.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { ColumnDef } from '@/types/data-table';
import type { RegistrationInvitation } from '@/types';

const props = defineProps<{ applicationId: string }>();

const { t } = useI18n();
const toast = useToast();

const invitations = ref<RegistrationInvitation[]>([]);
const loading = ref(true);
const saving = ref(false);
const showModal = ref(false);
const modalMode = ref<'create' | 'resend'>('create');
const form = ref({ email: '' });
const lastInviteUrl = ref('');
const lastInviteEmailSent = ref(false);

type InvitationDisplayStatus = 'pending' | 'consumed' | 'revoked' | 'expired';

function statusOf(invitation: RegistrationInvitation): InvitationDisplayStatus {
  if (invitation.consumedAt) return 'consumed';
  if (invitation.revokedAt) return 'revoked';
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function statusLabel(invitation: RegistrationInvitation): string {
  return t(`appDetail.invitationStatus.${statusOf(invitation)}`);
}

function statusVariant(invitation: RegistrationInvitation): 'success' | 'neutral' | 'error' | 'warning' {
  const status = statusOf(invitation);
  if (status === 'consumed') return 'success';
  if (status === 'revoked' || status === 'expired') return 'error';
  return 'warning';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const columns = computed<ColumnDef<RegistrationInvitation>[]>(() => [
  { key: 'email', label: t('appDetail.invitationEmail') },
  { key: 'status', label: t('common.status'), responsive: 'sm' },
  { key: 'createdAt', label: t('appDetail.invitationCreated'), field: 'createdAt', sortable: true, responsive: 'md' },
  { key: 'expiresAt', label: t('appDetail.invitationExpires'), field: 'expiresAt', sortable: true, responsive: 'md' },
  { key: 'actions', label: t('users.columns.actions'), align: 'right' },
]);

async function load() {
  loading.value = true;
  try {
    invitations.value = (await invitationsApi.listRegistrationInvitations(props.applicationId)).invitations;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('appDetail.operationFailed'));
  } finally {
    loading.value = false;
  }
}

function openModal() {
  modalMode.value = 'create';
  form.value = { email: '' };
  lastInviteUrl.value = '';
  lastInviteEmailSent.value = false;
  showModal.value = true;
}

async function sendInvitation() {
  const email = form.value.email.trim();
  if (!email) return;
  saving.value = true;
  try {
    const res = await invitationsApi.createRegistrationInvitation({
      email,
      applicationId: props.applicationId,
    });
    invitations.value = [res.invitation, ...invitations.value];
    lastInviteUrl.value = res.inviteUrl;
    lastInviteEmailSent.value = res.emailSent;
    toast.success(
      res.emailSent
        ? t('appDetail.invitationSent')
        : t('appDetail.invitationCreatedNoMail'),
    );
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('appDetail.operationFailed'));
  } finally {
    saving.value = false;
  }
}

async function resend(invitation: RegistrationInvitation) {
  try {
    const res = await invitationsApi.resendRegistrationInvitation(invitation.id);
    invitations.value = [
      res.invitation,
      ...invitations.value.map((i) =>
        i.id === invitation.id ? { ...i, revokedAt: new Date().toISOString() } : i,
      ),
    ];
    modalMode.value = 'resend';
    form.value = { email: invitation.email };
    lastInviteUrl.value = res.inviteUrl;
    lastInviteEmailSent.value = res.emailSent;
    showModal.value = true;
    toast.success(t('appDetail.invitationResent'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('appDetail.operationFailed'));
  }
}

async function revoke(invitation: RegistrationInvitation) {
  try {
    const res = await invitationsApi.revokeRegistrationInvitation(invitation.id);
    invitations.value = invitations.value.map((i) =>
      i.id === invitation.id ? res.invitation : i,
    );
    toast.success(t('appDetail.invitationRevoked'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('appDetail.operationFailed'));
  }
}

onMounted(load);
watch(() => props.applicationId, load);
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-surface-500">{{ t('appDetail.invitationsHint') }}</p>
      <BaseButton size="sm" @click="openModal">
        <Mail class="w-3.5 h-3.5" />{{ t('appDetail.inviteByEmail') }}
      </BaseButton>
    </div>

    <DataTable
      :columns="columns"
      :items="invitations"
      :loading="loading"
      :empty="!loading && invitations.length === 0"
      :row-key="(i: RegistrationInvitation) => i.id"
    >
      <template #empty>
        <div class="px-5 py-8 text-center text-sm text-surface-500">{{ t('appDetail.noInvitations') }}</div>
      </template>
      <template #cell-email="{ row }">
        <span class="text-sm text-surface-200">{{ (row as RegistrationInvitation).email }}</span>
      </template>
      <template #cell-status="{ row }">
        <BaseBadge :variant="statusVariant(row as RegistrationInvitation)" size="sm" dot>
          {{ statusLabel(row as RegistrationInvitation) }}
        </BaseBadge>
      </template>
      <template #cell-createdAt="{ row }">
        <span class="text-xs text-surface-500">{{ formatDate((row as RegistrationInvitation).createdAt) }}</span>
      </template>
      <template #cell-expiresAt="{ row }">
        <span class="text-xs text-surface-500">{{ formatDate((row as RegistrationInvitation).expiresAt) }}</span>
      </template>
      <template #cell-actions="{ row }">
        <div v-if="statusOf(row as RegistrationInvitation) === 'pending'" class="flex items-center justify-end gap-1">
          <button
            @click="resend(row as RegistrationInvitation)"
            class="p-1.5 rounded-lg text-surface-500 hover:text-primary-300 hover:bg-primary-500/10 transition-all"
            :title="t('appDetail.resendInvitation')"
          >
            <Send class="w-4 h-4" />
          </button>
          <button
            @click="revoke(row as RegistrationInvitation)"
            class="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-all"
            :title="t('appDetail.revokeInvitation')"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </template>
    </DataTable>

    <BaseModal :open="showModal" :title="t('appDetail.inviteByEmail')" @close="showModal = false">
      <div class="space-y-4">
        <BaseInput
          v-if="modalMode === 'create'"
          v-model="form.email"
          :label="t('appDetail.invitationEmail')"
          type="email"
          placeholder="person@example.com"
          required
        />
        <p class="text-xs text-surface-500">{{ t('appDetail.invitationHint') }}</p>
        <div v-if="lastInviteUrl" class="space-y-2 rounded-xl border border-surface-700/40 bg-surface-800/40 p-3">
          <p class="text-xs" :class="lastInviteEmailSent ? 'text-surface-400' : 'text-amber-400'">
            {{ lastInviteEmailSent ? t('appDetail.invitationEmailSent') : t('appDetail.invitationEmailNotSent') }}
          </p>
          <CopyField :value="lastInviteUrl" :label="t('appDetail.invitationLink')" />
        </div>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showModal = false">
          {{ lastInviteUrl ? t('common.close') : t('common.cancel') }}
        </BaseButton>
        <BaseButton
          v-if="modalMode === 'create'"
          :loading="saving"
          :disabled="!form.email.trim()"
          @click="sendInvitation"
        >
          {{ t('appDetail.sendInvitation') }}
        </BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
