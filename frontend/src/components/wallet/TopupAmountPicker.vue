<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseInput from '@/components/ui/BaseInput.vue';
import { useMoney } from '@/composables/useMoney';
import { TOPUP_PRESETS_EUR } from '@/utils/topupPresets';
import type { TopupOptions } from '@/types/wallet';

const props = defineProps<{
  modelValue: string;
  options: TopupOptions;
  error?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();
const { fmt } = useMoney();

const range = computed(() => ({
  min: fmt(BigInt(props.options.minCents) * 10_000n),
  max: fmt(BigInt(props.options.maxCents) * 10_000n),
}));
</script>

<template>
  <div>
    <div class="flex flex-wrap gap-2 mb-4">
      <button
        v-for="eur in TOPUP_PRESETS_EUR"
        :key="eur"
        type="button"
        :class="[
          'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
          modelValue === String(eur)
            ? 'bg-primary-600/20 border-primary-500/50 text-primary-300'
            : 'border-surface-700 text-surface-300 hover:bg-surface-800',
        ]"
        @click="emit('update:modelValue', String(eur))"
      >{{ fmt(BigInt(eur) * 1_000_000n) }}</button>
    </div>
    <BaseInput
      :model-value="modelValue"
      :label="t('wallet.topup.amount')"
      inputmode="decimal"
      :error="error"
      :hint="t('wallet.topup.range', range)"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
