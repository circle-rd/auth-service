<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Copy, Plus, Trash2 } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import { useToast } from '@/composables/useToast';
import {
  createSshMetaUser,
  deleteSshMetaUser,
  getSshTarget,
  listSshMetaUsers,
  requestValidation,
  setupSshTarget,
  type SshMetaUser,
  type SshOwnerDetail,
} from '@/api/resources';

const props = defineProps<{
  open: boolean;
  resourceId: string;
  resourceName: string;
}>();
const emit = defineEmits<{ close: []; updated: [] }>();

const { t } = useI18n();
const toast = useToast();

const loading = ref(false);
const saving = ref(false);
const detail = ref<SshOwnerDetail | null>(null);
const form = reactive({ host: '', port: 22, account: '' });
const copied = ref('');
const validationCommand = ref<string | null>(null);
const metaUsers = ref<SshMetaUser[]>([]);
const newMetaUser = ref('');

async function load() {
  loading.value = true;
  try {
    const res = await getSshTarget(props.resourceId);
    detail.value = res.ssh;
    Object.assign(form, {
      host: res.ssh.host,
      port: res.ssh.port,
      account: res.ssh.account,
    });
    validationCommand.value = res.ssh.validationCommand;
    metaUsers.value = (await listSshMetaUsers(props.resourceId)).metaUsers;
  } catch {
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

async function addMetaUser() {
  if (!newMetaUser.value.trim()) return;
  saving.value = true;
  try {
    await createSshMetaUser(props.resourceId, newMetaUser.value.trim());
    newMetaUser.value = '';
    metaUsers.value = (await listSshMetaUsers(props.resourceId)).metaUsers;
    toast.success(t('share.ssh.metaUserAdded'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

async function removeMetaUser(metaUser: string) {
  try {
    await deleteSshMetaUser(props.resourceId, metaUser);
    metaUsers.value = metaUsers.value.filter((item) => item.metaUser !== metaUser);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

async function save() {
  saving.value = true;
  try {
    const res = await setupSshTarget(props.resourceId, {
      host: form.host.trim(),
      port: form.port,
      account: form.account.trim(),
    });
    detail.value = res.ssh;
    validationCommand.value = res.ssh.validationCommand;
    toast.success(t('share.ssh.saved'));
    emit('updated');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

async function validate() {
  saving.value = true;
  try {
    const res = await requestValidation(props.resourceId);
    validationCommand.value = res.validationCommand;
    toast.success(t('share.ssh.validationReady'));
    emit('updated');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

async function copy(value: string, label: string) {
  await navigator.clipboard.writeText(value);
  copied.value = label;
  setTimeout(() => {
    if (copied.value === label) copied.value = '';
  }, 1500);
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);
onMounted(() => {
  if (props.open) void load();
});
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('share.ssh.title', { name: resourceName })"
    size="lg"
    @close="emit('close')"
  >
    <div v-if="loading" class="h-40 rounded-xl bg-surface-800/40 animate-pulse" />
    <div v-else class="space-y-5">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <BaseInput v-model="form.host" :label="t('share.ssh.host')" required />
        <BaseInput v-model.number="form.port" type="number" :label="t('share.ssh.port')" />
        <BaseInput v-model="form.account" :label="t('share.ssh.account')" required />
      </div>
      <p class="text-xs text-surface-500">{{ t('share.ssh.targetHint') }}</p>
      <div class="flex justify-end">
        <BaseButton :loading="saving" :disabled="!form.host.trim() || !form.account.trim()" @click="save">
          {{ detail ? t('common.save') : t('share.ssh.configure') }}
        </BaseButton>
      </div>

      <template v-if="detail">
        <div class="space-y-2">
          <p class="text-sm font-medium text-surface-200">{{ t('share.ssh.authorizedKeys') }}</p>
          <p class="text-xs text-surface-500">{{ t('share.ssh.authorizedKeysHint') }}</p>
          <div class="flex items-start gap-2 rounded-xl bg-surface-800/60 p-3">
            <code class="text-xs text-primary-300 break-all flex-1">{{ detail.authorizedKeysLine }}</code>
            <BaseButton variant="ghost" size="sm" @click="copy(detail.authorizedKeysLine, 'keys')">
              <Check v-if="copied === 'keys'" class="w-3.5 h-3.5" />
              <Copy v-else class="w-3.5 h-3.5" />
            </BaseButton>
          </div>
        </div>

        <div class="space-y-2">
          <p class="text-sm font-medium text-surface-200">{{ t('share.ssh.validation') }}</p>
          <p class="text-xs text-surface-500">{{ t('share.ssh.validationHint') }}</p>
          <div class="flex items-start gap-2 rounded-xl bg-surface-800/60 p-3">
            <code class="text-xs text-primary-300 break-all flex-1">
              {{ validationCommand ?? t('share.ssh.validationUnavailable') }}
            </code>
            <BaseButton
              v-if="validationCommand"
              variant="ghost"
              size="sm"
              @click="copy(validationCommand, 'command')"
            >
              <Check v-if="copied === 'command'" class="w-3.5 h-3.5" />
              <Copy v-else class="w-3.5 h-3.5" />
            </BaseButton>
          </div>
          <div class="flex justify-end">
            <BaseButton :loading="saving" :disabled="!validationCommand" @click="validate">
              {{ t('share.ssh.validate') }}
            </BaseButton>
          </div>
        </div>

        <div class="space-y-2">
          <p class="text-sm font-medium text-surface-200">{{ t('share.ssh.metaUsers') }}</p>
          <p class="text-xs text-surface-500">{{ t('share.ssh.metaUsersHint') }}</p>
          <div class="flex gap-2">
            <BaseInput v-model="newMetaUser" :label="t('share.ssh.metaUser')" class="flex-1" />
            <BaseButton :loading="saving" :disabled="!newMetaUser.trim()" @click="addMetaUser">
              <Plus class="w-3.5 h-3.5" />{{ t('share.ssh.addMetaUser') }}
            </BaseButton>
          </div>
          <div v-if="metaUsers.length > 0" class="space-y-1">
            <div
              v-for="item in metaUsers"
              :key="item.id"
              class="flex items-center justify-between rounded-lg bg-surface-800/60 px-3 py-2"
            >
              <code class="text-xs text-primary-300">{{ item.metaUser }}</code>
              <BaseButton variant="ghost" size="sm" @click="removeMetaUser(item.metaUser)">
                <Trash2 class="w-3.5 h-3.5" />
              </BaseButton>
            </div>
          </div>
        </div>

        <div class="text-xs text-surface-500">
          <p>{{ t('share.ssh.fingerprint', { value: detail.fingerprint }) }}</p>
          <p v-if="detail.hostKeyFingerprint">
            {{ t('share.ssh.hostKey', { value: detail.hostKeyFingerprint }) }}
          </p>
          <p>{{ t('share.ssh.validatedAt', { value: detail.validatedAt ? new Date(detail.validatedAt).toLocaleString() : t('share.ssh.notValidated') }) }}</p>
        </div>
      </template>
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.close') }}</BaseButton>
    </template>
  </BaseModal>
</template>
