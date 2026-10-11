<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { adjustBalance, grantCredit, recordTopup } from '@/api/wallet';
import { useToast } from '@/composables/useToast';
import { parseEurToMicro } from '@/utils/money';

export type WalletActionMode = 'topup' | 'grant' | 'adjust';

const props = defineProps<{
  open: boolean;
  userId: string;
  mode: WalletActionMode;
}>();

const emit = defineEmits<{ close: []; done: [] }>();

const { t } = useI18n();
const toast = useToast();

const amount = ref('');
const text = ref('');
const amountError = ref('');
const submitting = ref(false);
// A fresh key per opening: retrying the same submit is replay-safe, a new opening is a new operation.
const idempotencyKey = ref(crypto.randomUUID());

watch(() => props.open, (open) => {
  if (!open) return;
  amount.value = '';
  text.value = '';
  amountError.value = '';
  idempotencyKey.value = crypto.randomUUID();
});

const titleKey = computed(() => `wallet.admin.actions.${props.mode}`);
const helpKey = computed(() => `wallet.admin.form.${props.mode}Help`);
const textLabel = computed(() =>
  props.mode === 'topup' ? t('wallet.admin.form.reference') : t('wallet.admin.form.reason'),
);
const canSubmit = computed(() => text.value.trim() !== '' && amount.value.trim() !== '');

async function submit(): Promise<void> {
  const micro = parseEurToMicro(amount.value, { allowNegative: props.mode === 'adjust' });
  if (micro === null) {
    amountError.value = t('wallet.admin.form.invalidAmount');
    return;
  }
  amountError.value = '';
  submitting.value = true;
  try {
    const key = idempotencyKey.value;
    const reason = text.value.trim();
    const res = props.mode === 'topup'
      ? await recordTopup(props.userId, { amount: micro, reference: reason, idempotencyKey: key })
      : props.mode === 'grant'
        ? await grantCredit(props.userId, { amount: micro, reason, idempotencyKey: key })
        : await adjustBalance(props.userId, { amount: micro, reason, idempotencyKey: key });
    toast.success(res.replayed ? t('wallet.admin.replayed') : t('wallet.admin.saved'));
    emit('done');
    emit('close');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.admin.error'));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <BaseModal :open="open" :title="t(titleKey)" size="sm" @close="emit('close')">
    <form class="space-y-4" @submit.prevent="submit">
      <p class="text-sm text-surface-400">{{ t(helpKey) }}</p>
      <BaseInput
        v-model="amount"
        :label="t('wallet.admin.form.amount')"
        inputmode="decimal"
        :error="amountError"
        :hint="mode === 'adjust' ? t('wallet.admin.form.adjustHint') : t('wallet.admin.form.amountHint')"
        required
      />
      <BaseInput
        v-model="text"
        :label="textLabel"
        :hint="mode === 'topup' ? undefined : t('wallet.admin.form.reasonHint')"
        required
      />
      <div class="flex justify-end gap-2 pt-2">
        <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
        <BaseButton type="submit" :loading="submitting" :disabled="!canSubmit">
          {{ t('wallet.admin.form.submit') }}
        </BaseButton>
      </div>
    </form>
  </BaseModal>
</template>
