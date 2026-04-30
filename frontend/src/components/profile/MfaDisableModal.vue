<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldOff, AlertTriangle } from 'lucide-vue-next';
import { disableTwoFactor } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; success: [] }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const password = ref('');
const loading = ref(false);
const error = ref('');

watch(() => props.open, (open) => {
  if (open) {
    password.value = '';
    error.value = '';
    loading.value = false;
  }
});

async function handleDisable() {
  if (!password.value) return;
  loading.value = true;
  error.value = '';
  try {
    await disableTwoFactor(password.value);
    await auth.fetchSession();
    toast.success(t('mfa.disable.successToast'));
    emit('success');
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('mfa.errors.disableFailed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <BaseModal :open="open" :title="t('mfa.disable.title')" size="sm" @close="emit('close')">
    <div class="space-y-4">
      <div class="flex items-start gap-3 rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
        <AlertTriangle class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <p class="text-xs text-amber-200">{{ t('mfa.disable.warning') }}</p>
      </div>
      <BaseInput
        v-model="password"
        :label="t('mfa.disable.passwordLabel')"
        type="password"
        required
        :error="error"
        @keyup.enter="handleDisable"
      />
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton
        variant="danger"
        :loading="loading"
        :disabled="!password"
        @click="handleDisable"
      >
        <ShieldOff class="w-4 h-4" />
        {{ t('mfa.disable.action') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
