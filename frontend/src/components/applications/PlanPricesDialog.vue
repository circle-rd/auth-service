<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Pencil, Trash2 } from 'lucide-vue-next';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import * as appsApi from '@/api/applications';
import { useToast } from '@/composables/useToast';
import type { SubscriptionPlan, SubscriptionPlanPrice } from '@/types';
import type { SelectOption } from '@/types/select';

/**
 * The prices of one plan. A fixed price is what the plan charges; a metered
 * price bills one feature by usage, with a unit label and a hard cap per
 * period. Both are rows of the same table, so the billing sync (Stripe Price,
 * Meter) and the usage caps read one source.
 */
const props = defineProps<{
  open: boolean;
  appId: string;
  plan: SubscriptionPlan | null;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();

const { t } = useI18n();
const toast = useToast();

const FEATURE_KEY_RE = /^[a-zA-Z0-9.]{1,64}$/;
const intervalOptions = computed<SelectOption[]>(() => [
  { value: 'month', label: t('plans.prices.monthly') },
  { value: 'year', label: t('plans.prices.yearly') },
  { value: 'one_time', label: t('plans.prices.oneTime') },
]);

const fixedPrices = computed(() => props.plan?.prices.filter((p) => p.billingType === 'fixed') ?? []);
const meteredPrices = computed(() => props.plan?.prices.filter((p) => p.billingType === 'metered') ?? []);
const currency = computed(() => fixedPrices.value[0]?.currency ?? meteredPrices.value[0]?.currency ?? 'eur');

const billedByUsage = ref(false);
const saving = ref(false);
const fixedForm = ref({ name: '', amount: '', interval: 'month' as 'month' | 'year' | 'one_time' });
const meteredForm = ref({ name: '', featureKey: '', unit: '', pricePerUnit: '', usageLimit: '', unlimited: false });

/** Why the add form cannot be submitted yet, or null when it can. */
const addError = computed<string | null>(() => {
  if (billedByUsage.value) {
    const f = meteredForm.value;
    if (!f.name.trim()) return t('plans.prices.errors.name');
    if (!FEATURE_KEY_RE.test(f.featureKey)) return t('plans.prices.errors.featureKey');
    if (meteredPrices.value.some((p) => p.featureKey === f.featureKey)) return t('plans.prices.errors.featureTaken');
    if (!f.unit.trim()) return t('plans.prices.errors.unit');
    if (!/^\d+$/.test(f.pricePerUnit)) return t('plans.prices.errors.amount');
    if (!f.unlimited && !/^\d+$/.test(f.usageLimit)) return t('plans.prices.errors.usageLimit');
    return null;
  }
  const f = fixedForm.value;
  if (!f.name.trim()) return t('plans.prices.errors.name');
  if (!/^\d+$/.test(f.amount)) return t('plans.prices.errors.amount');
  return null;
});

async function addPrice(): Promise<void> {
  if (!props.plan || addError.value) return;
  saving.value = true;
  try {
    if (billedByUsage.value) {
      const f = meteredForm.value;
      await appsApi.createPrice(props.appId, props.plan.id, {
        name: f.name.trim(),
        amount: Number(f.pricePerUnit),
        currency: currency.value,
        interval: 'month',
        billingType: 'metered',
        featureKey: f.featureKey,
        unit: f.unit.trim(),
        usageLimit: f.unlimited ? -1 : Number(f.usageLimit),
      });
      meteredForm.value = { name: '', featureKey: '', unit: '', pricePerUnit: '', usageLimit: '', unlimited: false };
    } else {
      const f = fixedForm.value;
      await appsApi.createPrice(props.appId, props.plan.id, {
        name: f.name.trim(),
        amount: Number(f.amount),
        currency: currency.value,
        interval: f.interval,
      });
      fixedForm.value = { name: '', amount: '', interval: 'month' };
    }
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    saving.value = false;
  }
}

// ── Editing a row: the name, and for a metered feature its unit and cap ──────

const editingId = ref<string | null>(null);
const editDraft = ref({ name: '', unit: '', usageLimit: '' });

function startEdit(price: SubscriptionPlanPrice): void {
  editingId.value = price.id;
  editDraft.value = {
    name: price.name,
    unit: price.unit ?? '',
    usageLimit: price.usageLimit === null || price.usageLimit < 0 ? '' : String(price.usageLimit),
  };
}

async function saveEdit(price: SubscriptionPlanPrice): Promise<void> {
  if (!props.plan) return;
  const body: { name?: string; unit?: string; usageLimit?: number } = { name: editDraft.value.name.trim() };
  if (price.billingType === 'metered') {
    body.unit = editDraft.value.unit.trim();
    body.usageLimit = editDraft.value.usageLimit === '' ? -1 : Number(editDraft.value.usageLimit);
  }
  saving.value = true;
  try {
    await appsApi.updatePlanPrice(props.appId, props.plan.id, price.id, body);
    editingId.value = null;
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    saving.value = false;
  }
}

// ── Removing a row archives its Stripe Price (and Meter, when unused) ────────

const pendingDelete = ref<SubscriptionPlanPrice | null>(null);
const deleting = ref(false);

async function confirmDelete(): Promise<void> {
  if (!props.plan || !pendingDelete.value) return;
  deleting.value = true;
  try {
    await appsApi.deletePrice(props.appId, props.plan.id, pendingDelete.value.id);
    pendingDelete.value = null;
    emit('changed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    deleting.value = false;
  }
}

function money(amount: string, code: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: code.toUpperCase(), minimumFractionDigits: 2 }).format(
    Number(amount) / 100,
  );
}

function capLabel(price: SubscriptionPlanPrice): string {
  if (price.usageLimit === null || price.usageLimit < 0) return t('plans.prices.unlimited');
  return `${price.usageLimit.toLocaleString()} ${price.unit ?? ''}`.trim();
}
</script>

<template>
  <BaseModal :open="open" :title="t('plans.prices.title', { plan: plan?.name ?? '' })" size="lg" @close="emit('close')">
    <div class="space-y-6">
      <!-- Subscription prices -->
      <section>
        <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-2">{{ t('plans.prices.subscription') }}</p>
        <p v-if="!fixedPrices.length" class="text-sm text-surface-500">{{ t('plans.prices.noneFixed') }}</p>
        <ul v-else class="divide-y divide-surface-800/40">
          <li v-for="price in fixedPrices" :key="price.id" class="py-2.5 flex items-center justify-between gap-3 text-sm">
            <template v-if="editingId === price.id">
              <BaseInput v-model="editDraft.name" class="flex-1" />
              <BaseButton size="sm" :loading="saving" @click="saveEdit(price)">{{ t('common.save') }}</BaseButton>
            </template>
            <template v-else>
              <span class="text-surface-200 truncate">{{ price.name }}</span>
              <div class="flex items-center gap-3 shrink-0">
                <span class="font-semibold text-surface-100">{{ money(price.amount, price.currency) }} / {{ price.interval }}</span>
                <BaseBadge v-if="price.stripePriceId" variant="success" size="sm">Stripe</BaseBadge>
                <button type="button" :aria-label="t('common.edit')" class="text-surface-400 hover:text-surface-200" @click="startEdit(price)"><Pencil class="w-3.5 h-3.5" /></button>
                <button type="button" :aria-label="t('common.delete')" class="text-red-500 hover:text-red-400" @click="pendingDelete = price"><Trash2 class="w-3.5 h-3.5" /></button>
              </div>
            </template>
          </li>
        </ul>
      </section>

      <!-- Metered features -->
      <section>
        <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-2">{{ t('plans.prices.metered') }}</p>
        <p v-if="!meteredPrices.length" class="text-sm text-surface-500">{{ t('plans.prices.noneMetered') }}</p>
        <ul v-else class="divide-y divide-surface-800/40">
          <li v-for="price in meteredPrices" :key="price.id" class="py-2.5 space-y-2 text-sm">
            <template v-if="editingId === price.id">
              <div class="grid grid-cols-3 gap-2">
                <BaseInput v-model="editDraft.name" :label="t('plans.prices.name')" />
                <BaseInput v-model="editDraft.unit" :label="t('plans.prices.unit')" />
                <BaseInput v-model="editDraft.usageLimit" :label="t('plans.prices.cap')" :placeholder="t('plans.prices.unlimited')" type="number" />
              </div>
              <div class="flex justify-end gap-2">
                <BaseButton variant="ghost" size="sm" @click="editingId = null">{{ t('common.cancel') }}</BaseButton>
                <BaseButton size="sm" :loading="saving" @click="saveEdit(price)">{{ t('common.save') }}</BaseButton>
              </div>
            </template>
            <template v-else>
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <span class="text-surface-200">{{ price.name }}</span>
                  <code class="ml-2 text-xs font-mono text-surface-500">{{ price.featureKey }}</code>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-surface-100 font-semibold">{{ money(price.amount, price.currency) }} / {{ price.unit }}</span>
                  <BaseBadge v-if="price.stripePriceId" variant="success" size="sm">Stripe</BaseBadge>
                  <button type="button" :aria-label="t('common.edit')" class="text-surface-400 hover:text-surface-200" @click="startEdit(price)"><Pencil class="w-3.5 h-3.5" /></button>
                  <button type="button" :aria-label="t('common.delete')" class="text-red-500 hover:text-red-400" @click="pendingDelete = price"><Trash2 class="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <p class="text-xs text-surface-500">{{ t('plans.prices.capLine', { cap: capLabel(price) }) }}</p>
            </template>
          </li>
        </ul>
      </section>

      <!-- Add a price: the toggle chooses what it bills -->
      <section class="rounded-xl bg-surface-800/40 border border-surface-700/30 p-4 space-y-3">
        <BaseToggle v-model="billedByUsage" :label="t('plans.prices.billedByUsage')" :description="t('plans.prices.billedByUsageHint')" />

        <div v-if="!billedByUsage" class="grid grid-cols-2 gap-3">
          <BaseInput v-model="fixedForm.name" :label="t('plans.prices.name')" required />
          <BaseInput v-model="fixedForm.amount" :label="t('plans.prices.amountMinor', { currency: currency.toUpperCase() })" type="number" required />
          <BaseSelect v-model="fixedForm.interval" :label="t('plans.prices.interval')" :options="intervalOptions" class="col-span-2" />
        </div>

        <div v-else class="grid grid-cols-2 gap-3">
          <BaseInput v-model="meteredForm.name" :label="t('plans.prices.name')" required />
          <BaseInput v-model="meteredForm.featureKey" :label="t('plans.prices.featureKey')" placeholder="api.calls" required />
          <BaseInput v-model="meteredForm.unit" :label="t('plans.prices.unit')" placeholder="call" required />
          <BaseInput v-model="meteredForm.pricePerUnit" :label="t('plans.prices.pricePerUnit', { currency: currency.toUpperCase() })" type="number" required />
          <BaseInput v-model="meteredForm.usageLimit" :label="t('plans.prices.cap')" type="number" :disabled="meteredForm.unlimited" />
          <BaseToggle v-model="meteredForm.unlimited" :label="t('plans.prices.unlimited')" class="self-end" />
          <p class="col-span-2 text-xs text-surface-500">{{ t('plans.prices.meteredHint') }}</p>
        </div>

        <div class="flex items-center justify-between gap-3">
          <p v-if="addError" class="text-xs text-amber-400">{{ addError }}</p>
          <span v-else />
          <BaseButton :loading="saving" :disabled="!!addError" @click="addPrice">{{ t('plans.prices.add') }}</BaseButton>
        </div>
      </section>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.close') }}</BaseButton>
    </template>
  </BaseModal>

  <ConfirmDialog
    :open="pendingDelete !== null"
    :title="t('plans.prices.deleteTitle')"
    :message="t('plans.prices.deleteMessage', { name: pendingDelete?.name ?? '' })"
    :loading="deleting"
    @confirm="confirmDelete"
    @cancel="pendingDelete = null"
  />
</template>
