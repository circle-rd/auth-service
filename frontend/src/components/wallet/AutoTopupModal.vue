<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import TopupAmountPicker from '@/components/wallet/TopupAmountPicker.vue';
import { useMoney } from '@/composables/useMoney';
import { eurToCents } from '@/utils/money';
import type { AutoTopup, TopupOptions } from '@/types/wallet';

const props = defineProps<{
  open: boolean;
  options: TopupOptions;
  current: AutoTopup | null;
  saving: boolean;
}>();

const emit = defineEmits<{ close: []; submit: [amountCents: number] }>();

const { t } = useI18n();
const { fmt } = useMoney();

const DEFAULT_AMOUNT = '10';

const amount = ref(DEFAULT_AMOUNT);
const consent = ref(false);
const showError = ref(false);

// Each opening starts from the saved amount; consent is always asked again.
watch(() => props.open, (open) => {
  if (!open) return;
  amount.value = props.current?.amountCents != null
    ? String(props.current.amountCents / 100)
    : DEFAULT_AMOUNT;
  consent.value = false;
  showError.value = false;
});

const cents = computed(() => eurToCents(amount.value));
const inRange = computed(() =>
  cents.value !== null &&
  cents.value >= props.options.minCents && cents.value <= props.options.maxCents,
);
const editing = computed(() => props.current?.enabled === true);
// Only an https link from the server is shown as a link.
const termsUrl = computed(() =>
  props.options.autoTopupTermsUrl?.startsWith('https://') ? props.options.autoTopupTermsUrl : null,
);
const error = computed(() => showError.value && !inRange.value
  ? t('wallet.topup.invalidAmount', {
    min: fmt(BigInt(props.options.minCents) * 10_000n),
    max: fmt(BigInt(props.options.maxCents) * 10_000n),
  })
  : '');
const canSubmit = computed(() => inRange.value && (editing.value || consent.value));

function submit(): void {
  if (!inRange.value || cents.value === null) {
    showError.value = true;
    return;
  }
  emit('submit', cents.value);
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('wallet.autoTopup.modalTitle')"
    size="md"
    @close="emit('close')"
  >
    <div class="space-y-5" data-testid="auto-topup-modal">
      <p class="text-sm text-surface-400">{{ t('wallet.autoTopup.modalIntro') }}</p>

      <TopupAmountPicker v-model="amount" :options="options" :error="error" />

      <label v-if="!editing" class="flex items-start gap-2.5 cursor-pointer">
        <input v-model="consent" type="checkbox" class="mt-0.5 w-4 h-4 rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500/50" />
        <span class="text-xs text-surface-300">
          {{ t('wallet.autoTopup.consent', { amount: fmt(BigInt(cents ?? 0) * 10_000n) }) }}
          <a
            v-if="termsUrl"
            :href="termsUrl"
            target="_blank"
            rel="noopener"
            class="text-primary-400 hover:underline"
            @click.stop
          >{{ t('wallet.autoTopup.terms') }}</a>
        </span>
      </label>

      <p class="text-xs text-surface-500">{{ t('wallet.autoTopup.noteEuro') }}</p>
    </div>

    <template #footer>
      <div class="flex gap-2 sm:gap-3 pt-4">
        <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!canSubmit" @click="submit">
          {{ editing ? t('wallet.autoTopup.save') : t('wallet.autoTopup.activate') }}
        </BaseButton>
      </div>
    </template>
  </BaseModal>
</template>
