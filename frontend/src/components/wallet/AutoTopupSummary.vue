<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RefreshCcw } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useMoney } from '@/composables/useMoney';
import type { AutoTopup } from '@/types/wallet';

const props = defineProps<{
  autoTopup: AutoTopup | null;
  busy: boolean;
}>();

const emit = defineEmits<{ configure: []; disable: [] }>();

const { t, locale } = useI18n();
const { fmt } = useMoney();

const amount = computed(() =>
  props.autoTopup?.amountCents != null ? fmt(BigInt(props.autoTopup.amountCents) * 10_000n) : '',
);
const lastTopup = computed(() => props.autoTopup?.lastTopupAt
  ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(props.autoTopup.lastTopupAt))
  : null);
</script>

<template>
  <div class="mt-5 pt-5 border-t border-surface-700/40" data-testid="auto-topup">
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <RefreshCcw class="w-4 h-4 text-surface-400 shrink-0" />
        <p class="text-sm font-medium text-surface-200">{{ t('wallet.autoTopup.title') }}</p>
      </div>
      <BaseBadge v-if="autoTopup" :variant="autoTopup.enabled ? 'success' : 'neutral'" size="sm" dot>
        {{ autoTopup.enabled ? t('wallet.autoTopup.on') : t('wallet.autoTopup.off') }}
      </BaseBadge>
    </div>

    <template v-if="autoTopup?.enabled">
      <p class="mt-2 text-sm text-surface-400" data-testid="auto-topup-amount">
        {{ t('wallet.autoTopup.activeHint', { amount }) }}
      </p>
      <p class="mt-1 text-xs text-surface-500" data-testid="auto-topup-last">
        {{ lastTopup ? t('wallet.autoTopup.lastTopup', { date: lastTopup }) : t('wallet.autoTopup.noTopupYet') }}
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <BaseButton variant="outline" size="sm" :disabled="busy" @click="emit('configure')">{{ t('common.edit') }}</BaseButton>
        <BaseButton variant="ghost" size="sm" :loading="busy" @click="emit('disable')">{{ t('wallet.autoTopup.turnOff') }}</BaseButton>
      </div>
    </template>

    <template v-else>
      <p class="mt-2 text-sm text-surface-400">{{ t('wallet.autoTopup.offHint') }}</p>
      <p v-if="autoTopup?.disabledReason" class="mt-2 text-xs text-amber-300" data-testid="auto-topup-reason">
        {{ t(`wallet.autoTopup.reasons.${autoTopup.disabledReason}`) }}
      </p>
      <div class="mt-3">
        <BaseButton variant="outline" size="sm" :disabled="!autoTopup || busy" @click="emit('configure')">
          {{ t('wallet.autoTopup.activate') }}
        </BaseButton>
      </div>
    </template>
  </div>
</template>
