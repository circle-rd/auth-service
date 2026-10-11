<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMoney } from '@/composables/useMoney';
import type { WalletBreakdownEntry, WalletKindEntry } from '@/types/wallet';

const props = defineProps<{
  byApplication: WalletBreakdownEntry[];
  byKind: WalletKindEntry[];
}>();

const { t } = useI18n();
const { fmt } = useMoney();

interface Row { key: string; label: string; amount: string; count: number; share: number }

function toRows(
  entries: { key: string; label: string; amount: string; count: number }[],
): Row[] {
  const total = entries.reduce((sum, e) => sum + BigInt(e.amount), 0n);
  return entries.map((e) => ({
    ...e,
    share: total === 0n ? 0 : Number((BigInt(e.amount) * 1000n) / total) / 10,
  }));
}

const applicationRows = computed(() =>
  toRows(props.byApplication.map((a) => ({
    key: a.applicationId ?? a.slug ?? 'unknown',
    label: a.name ?? a.slug ?? t('wallet.spend.unknownApp'),
    amount: a.amount,
    count: a.count,
  }))),
);

const kindRows = computed(() =>
  toRows(props.byKind.map((k) => ({
    key: k.kind,
    label: t(`wallet.spend.kinds.${['llm', 'mcp'].includes(k.kind) ? k.kind : 'other'}`),
    amount: k.amount,
    count: k.count,
  }))),
);

const sections = computed(() => [
  { title: t('wallet.spend.byApplication'), rows: applicationRows.value },
  { title: t('wallet.spend.byKind'), rows: kindRows.value },
].filter((s) => s.rows.length > 0));
</script>

<template>
  <div v-if="sections.length" class="grid sm:grid-cols-2 gap-6" data-testid="spend-breakdown">
    <div v-for="section in sections" :key="section.title">
      <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-3">{{ section.title }}</p>
      <ul class="space-y-3">
        <li v-for="row in section.rows" :key="row.key">
          <div class="flex items-baseline justify-between gap-3 text-sm">
            <span class="text-surface-200 truncate">{{ row.label }}</span>
            <span class="text-surface-400 tabular-nums shrink-0">{{ fmt(row.amount) }}</span>
          </div>
          <div class="mt-1 h-1.5 rounded-full bg-surface-800 overflow-hidden">
            <div class="h-full rounded-full bg-primary-500/70" :style="{ width: `${row.share}%` }" />
          </div>
          <p class="mt-0.5 text-xs text-surface-600">{{ t('wallet.spend.calls', { count: row.count }) }}</p>
        </li>
      </ul>
    </div>
  </div>
</template>
