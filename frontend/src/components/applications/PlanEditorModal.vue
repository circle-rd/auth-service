<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, X } from 'lucide-vue-next';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import * as appsApi from '@/api/applications';
import type { PlanFeatureValue } from '@/api/applications';
import { useToast } from '@/composables/useToast';
import type { SubscriptionPlan } from '@/types';

/**
 * Create or edit a plan: its name, description, default flag and the plain
 * features it includes. Metered features are not declared here: they are
 * prices, managed in the plan's price dialog once the plan exists.
 */
const props = defineProps<{
  open: boolean;
  appId: string;
  /** The plan to edit, or null to create one. */
  plan: SubscriptionPlan | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const { t } = useI18n();
const toast = useToast();

interface FeatureRow {
  key: string;
  value: string;
}

const form = ref({ name: '', description: '', isDefault: false });
const features = ref<FeatureRow[]>([]);
const saving = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.value = {
      name: props.plan?.name ?? '',
      description: props.plan?.description ?? '',
      isDefault: props.plan?.isDefault ?? false,
    };
    features.value = Object.entries(props.plan?.features ?? {}).map(([key, value]) => ({
      key,
      value: String(value),
    }));
  },
);

/** The typed value of a feature the admin typed: true/false, a number, or text. */
function typedValue(raw: string): PlanFeatureValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

const duplicateKey = computed(() => {
  const keys = features.value.map((f) => f.key.trim()).filter(Boolean);
  return new Set(keys).size !== keys.length;
});

async function save(): Promise<void> {
  if (duplicateKey.value) {
    toast.error(t('plans.errors.duplicateFeature'));
    return;
  }
  const included = Object.fromEntries(
    features.value
      .filter((f) => f.key.trim() !== '')
      .map((f) => [f.key.trim(), typedValue(f.value)]),
  );
  const body = {
    name: form.value.name,
    description: form.value.description,
    isDefault: form.value.isDefault,
    features: included,
  };
  saving.value = true;
  try {
    if (props.plan) {
      await appsApi.updatePlan(props.appId, props.plan.id, body);
      toast.success(t('plans.updated'));
    } else {
      await appsApi.createPlan(props.appId, body);
      toast.success(t('plans.created'));
    }
    emit('saved');
    emit('close');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal :open="open" :title="plan ? t('appDetail.editPlan') : t('appDetail.createPlan')" @close="emit('close')">
    <div class="space-y-4">
      <BaseInput v-model="form.name" :label="t('plans.name')" required />
      <BaseInput v-model="form.description" :label="t('plans.description')" />
      <BaseToggle v-model="form.isDefault" :label="t('plans.defaultPlan')" />

      <div>
        <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-1.5">{{ t('appDetail.features') }}</p>
        <div class="space-y-2">
          <div v-for="(row, i) in features" :key="i" class="flex items-center gap-2">
            <BaseInput v-model="row.key" placeholder="feature.key" class="flex-1 min-w-0" />
            <BaseInput v-model="row.value" :placeholder="t('plans.valuePlaceholder')" class="flex-1 min-w-0" />
            <button type="button" :aria-label="t('common.remove')" class="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0" @click="features.splice(i, 1)">
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
          <BaseButton variant="ghost" size="sm" @click="features.push({ key: '', value: '' })">
            <Plus class="w-3.5 h-3.5" /> {{ t('appDetail.addFeature') }}
          </BaseButton>
        </div>
        <p class="mt-2 text-xs text-surface-500">{{ t('plans.meteredHint') }}</p>
      </div>
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="saving" :disabled="!form.name.trim() || duplicateKey" @click="save">
        {{ plan ? t('common.save') : t('common.create') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
