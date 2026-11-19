<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, ChevronUp } from '@lucide/vue';
import SpendBreakdown from '@/components/wallet/SpendBreakdown.vue';
import type { WalletBreakdownEntry, WalletKindEntry, WalletModelEntry } from '@/types/wallet';

defineProps<{
  byApplication: WalletBreakdownEntry[];
  byKind: WalletKindEntry[];
  byModel: WalletModelEntry[];
}>();

const { t } = useI18n();
const open = ref(false);
</script>

<template>
  <div>
    <button
      type="button"
      class="inline-flex items-center gap-1.5 text-xs font-medium text-surface-400 hover:text-surface-200 transition-colors"
      :aria-expanded="open"
      data-testid="spend-details-toggle"
      @click="open = !open"
    >
      <component :is="open ? ChevronUp : ChevronDown" class="w-3.5 h-3.5" />
      {{ t('wallet.spend.details') }}
    </button>
    <SpendBreakdown
      v-if="open"
      class="mt-4"
      :by-application="byApplication"
      :by-kind="byKind"
      :by-model="byModel"
    />
  </div>
</template>
