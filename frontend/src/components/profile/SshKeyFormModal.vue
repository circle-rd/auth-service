<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import { useToast } from '@/composables/useToast';
import { registerRecipientKey, requestSshKeyChallenge, type SshKeyChallenge } from '@/api/resources';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ close: []; saved: [] }>();

const { t } = useI18n();
const toast = useToast();

const form = reactive({ publicKey: '', label: '', signature: '' });
const challenge = ref<SshKeyChallenge | null>(null);
const saving = ref(false);
const error = ref('');

// The private key never leaves the user's machine: they sign this challenge locally.
const signCommand = computed(() =>
  challenge.value
    ? `printf '%s' '${challenge.value.challenge}' | ssh-keygen -Y sign -n ${challenge.value.namespace} -f ~/.ssh/id_ed25519`
    : '',
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.publicKey = '';
    form.label = '';
    form.signature = '';
    challenge.value = null;
    error.value = '';
  },
);

async function askChallenge() {
  saving.value = true;
  error.value = '';
  try {
    challenge.value = await requestSshKeyChallenge(form.publicKey.trim());
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('share.saveError');
  } finally {
    saving.value = false;
  }
}

async function save() {
  if (!challenge.value) return;
  saving.value = true;
  error.value = '';
  try {
    await registerRecipientKey({
      publicKey: form.publicKey.trim(),
      challenge: challenge.value.challenge,
      signature: form.signature.trim(),
      label: form.label.trim() || undefined,
    });
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
    <div v-if="!challenge" class="space-y-3">
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
    <div v-else class="space-y-3">
      <p class="text-sm text-surface-400">{{ t('share.sshKeys.proofHint') }}</p>
      <pre class="rounded-lg bg-surface-950 border border-surface-700/50 p-3 text-xs text-surface-200 whitespace-pre-wrap break-all select-all" data-testid="ssh-sign-command">{{ signCommand }}</pre>
      <BaseInput
        v-model="form.signature"
        type="textarea"
        :rows="6"
        :label="t('share.sshKeys.signature')"
        :hint="t('share.sshKeys.signatureHint')"
        :error="error"
        placeholder="-----BEGIN SSH SIGNATURE-----"
        required
      />
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="challenge ? (challenge = null) : emit('close')">
        {{ challenge ? t('common.back') : t('common.cancel') }}
      </BaseButton>
      <BaseButton
        v-if="!challenge"
        :loading="saving"
        :disabled="!form.publicKey.trim()"
        @click="askChallenge"
      >
        {{ t('share.sshKeys.continue') }}
      </BaseButton>
      <BaseButton v-else :loading="saving" :disabled="!form.signature.trim()" @click="save">
        {{ t('share.sshKeys.add') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
