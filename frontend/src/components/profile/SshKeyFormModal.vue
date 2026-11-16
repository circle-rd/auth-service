<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import { useToast } from '@/composables/useToast';
import { registerRecipientKey } from '@/api/resources';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ close: []; saved: [] }>();

const { t } = useI18n();
const toast = useToast();

const form = reactive({ publicKey: '', label: '' });
const saving = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.publicKey = '';
    form.label = '';
    error.value = '';
  },
);

async function save() {
  saving.value = true;
  error.value = '';
  try {
    await registerRecipientKey(form.publicKey.trim(), form.label.trim() || undefined);
    toast.success(t('share.sshKeys.added'));
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('share.saveError');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal :open="open" :title="t('share.sshKeys.addTitle')" size="md" @close="emit('close')">
    <div class="space-y-3">
      <p class="text-sm text-surface-400">{{ t('share.sshKeys.identityHint') }}</p>
      <BaseInput v-model="form.label" :label="t('share.sshKeys.label')" :placeholder="t('share.sshKeys.labelPlaceholder')" />
      <BaseInput
        v-model="form.publicKey"
        type="textarea"
        :rows="4"
        :label="t('share.sshKeys.publicKey')"
        :hint="t('share.sshKeys.publicKeyHint')"
        :error="error"
        placeholder="ssh-ed25519 AAAA… user@host"
        required
      />
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="saving" :disabled="!form.publicKey.trim()" @click="save">
        {{ t('share.sshKeys.add') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
