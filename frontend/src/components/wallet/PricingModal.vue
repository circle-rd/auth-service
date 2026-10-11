<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { updatePricing } from '@/api/wallet';
import { useMoney } from '@/composables/useMoney';
import { useToast } from '@/composables/useToast';
import { parseRate, pricedOneDollar } from '@/utils/money';
import type { PricingSettings } from '@/types/wallet';

const props = defineProps<{
  open: boolean;
  current: PricingSettings | null;
}>();

const emit = defineEmits<{ close: []; done: [] }>();

const { t } = useI18n();
const { fmt } = useMoney();
const toast = useToast();

const rate = ref('');
const margin = ref('');
const reason = ref('');
const submitting = ref(false);
const touched = ref(false);

watch(() => props.open, (open) => {
  if (!open) return;
  rate.value = props.current?.usdToEurRate ?? '';
  margin.value = props.current ? String(props.current.marginPercent) : '0';
  reason.value = '';
  touched.value = false;
});

const parsedRate = computed(() => parseRate(rate.value));
const parsedMargin = computed(() => {
  const value = margin.value.trim();
  if (!/^[0-9]{1,4}$/.test(value)) return null;
  const n = Number(value);
  return n <= 1000 ? n : null;
});

const example = computed(() =>
  parsedRate.value !== null && parsedMargin.value !== null
    ? fmt(pricedOneDollar(parsedRate.value, parsedMargin.value))
    : null,
);

async function submit(): Promise<void> {
  touched.value = true;
  if (parsedRate.value === null || parsedMargin.value === null) return;
  submitting.value = true;
  try {
    await updatePricing({
      usdToEurRate: parsedRate.value,
      marginPercent: parsedMargin.value,
      reason: reason.value.trim(),
    });
    toast.success(t('wallet.pricing.saved'));
    emit('done');
    emit('close');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.pricing.error'));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <BaseModal :open="open" :title="t('wallet.pricing.edit')" size="sm" @close="emit('close')">
    <form class="space-y-4" @submit.prevent="submit">
      <BaseInput
        v-model="rate"
        :label="t('wallet.pricing.form.rate')"
        inputmode="decimal"
        :hint="t('wallet.pricing.form.rateHint')"
        :error="touched && parsedRate === null ? t('wallet.pricing.form.invalidRate') : ''"
        required
      />
      <BaseInput
        v-model="margin"
        :label="t('wallet.pricing.form.margin')"
        inputmode="numeric"
        :hint="t('wallet.pricing.form.marginHint')"
        :error="touched && parsedMargin === null ? t('wallet.pricing.form.invalidMargin') : ''"
        required
      />
      <BaseInput
        v-model="reason"
        :label="t('wallet.pricing.form.reason')"
        :hint="t('wallet.pricing.form.reasonHint')"
        required
      />
      <p v-if="example" class="text-sm text-surface-300">{{ t('wallet.pricing.example', { amount: example }) }}</p>
      <p class="text-xs text-surface-500">{{ t('wallet.pricing.form.applies') }}</p>
      <div class="flex justify-end gap-2 pt-2">
        <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
        <BaseButton type="submit" :loading="submitting" :disabled="reason.trim() === ''">
          {{ t('wallet.pricing.form.submit') }}
        </BaseButton>
      </div>
    </form>
  </BaseModal>
</template>
