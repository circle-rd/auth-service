<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Terminal } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import UriInput from '@/components/ui/UriInput.vue';
import { locatorSpec } from '@/utils/schemeLocator';
import { resolveSchemeIcon } from '@/utils/schemeIcons';
import type { Resource, ResourceScheme } from '@/api/resources';
import type { SelectOption } from '@/types/select';

export interface ResourceFormPayload {
  scheme: string;
  displayName: string;
  locator: string | undefined;
}

const props = defineProps<{
  open: boolean;
  schemes: ResourceScheme[];
  // Scheme preselected on creation; the type picker is hidden when it is fixed.
  fixedScheme?: string;
  editing: Resource | null;
  saving: boolean;
  error: string;
}>();

const emit = defineEmits<{
  close: [];
  submit: [payload: ResourceFormPayload];
}>();

const { t } = useI18n();

const form = reactive({ scheme: '', displayName: '', locator: '' });

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.scheme = props.editing?.scheme ?? props.fixedScheme ?? props.schemes[0]?.scheme ?? '';
    form.displayName = props.editing?.displayName ?? '';
    form.locator = props.editing ? props.editing.uri.slice(props.editing.scheme.length + 3) : '';
  },
);

const scheme = computed(() => props.schemes.find((entry) => entry.scheme === form.scheme) ?? null);
const isSsh = computed(() => form.scheme === 'ssh');
const spec = computed(() => locatorSpec(form.scheme));

const schemeOptions = computed<SelectOption[]>(() =>
  props.schemes.map((entry) => {
    const resolved = resolveSchemeIcon(entry.icon, entry.scheme);
    return {
      value: entry.scheme,
      label: entry.displayName,
      description: entry.description ?? undefined,
      icon: resolved.kind === 'component' ? resolved.component : undefined,
    };
  }),
);

const title = computed(
  () => form.displayName.trim() || scheme.value?.displayName || t('share.resources.createTitle'),
);
const subtitle = computed(() => {
  if (props.editing) return props.editing.uri;
  if (isSsh.value) return `${form.scheme}://`;
  return `${form.scheme}://${form.locator.trim()}`;
});
const tags = computed(() => {
  const list: Array<{ label: string; variant: 'primary' | 'success' | 'warning' | 'neutral' }> = [];
  if (scheme.value) list.push({ label: scheme.value.displayName, variant: 'primary' });
  if (props.editing) {
    const status = props.editing.status;
    list.push({
      label: t(`share.resourceStatuses.${status}`),
      variant: status === 'validated' ? 'success' : status === 'disabled' ? 'neutral' : 'warning',
    });
  }
  return list;
});

const canSave = computed(() => {
  if (form.displayName.trim().length === 0) return false;
  if (props.editing) return true;
  return form.scheme.length > 0 && (isSsh.value || form.locator.trim().length > 0);
});

function submit() {
  if (!canSave.value || props.saving) return;
  emit('submit', {
    scheme: form.scheme,
    displayName: form.displayName.trim(),
    locator: isSsh.value || props.editing ? undefined : form.locator.trim(),
  });
}
</script>

<template>
  <EntityModal
    :open="open"
    :name="title"
    :subtitle="subtitle"
    :tags="tags"
    size="md"
    @close="emit('close')"
  >
    <template #icon>
      <SchemeIcon :icon="scheme?.icon" :scheme="form.scheme" size="lg" />
    </template>

    <form class="space-y-4" @submit.prevent="submit">
      <p v-if="scheme?.description" class="text-sm text-surface-400">{{ scheme.description }}</p>

      <BaseSelect
        v-if="!editing && !fixedScheme"
        v-model="form.scheme"
        :label="t('share.resources.scheme')"
        :options="schemeOptions"
      />

      <BaseInput v-model="form.displayName" :label="t('share.resources.name')" required />

      <UriInput
        v-if="editing"
        :model-value="form.locator"
        :prefix="form.scheme"
        :label="t('share.resources.locator')"
        :hint="t('share.resources.locatorImmutable')"
        readonly
      />
      <UriInput
        v-else-if="!isSsh"
        v-model="form.locator"
        :prefix="form.scheme"
        :label="t('share.resources.locator')"
        :placeholder="spec.placeholder"
        :hint="t(`share.resources.locatorHints.${spec.hintKey}`)"
        :error="error"
        required
      />
      <div
        v-else
        class="flex items-start gap-3 rounded-xl border border-surface-700/50 bg-surface-950/40 p-3"
      >
        <Terminal class="w-4 h-4 text-surface-400 mt-0.5 shrink-0" />
        <p class="text-xs text-surface-400">{{ t('share.resources.sshLocatorHint') }}</p>
      </div>

      <p v-if="error && (editing || isSsh)" class="text-xs text-red-400">{{ error }}</p>

      <div
        v-if="editing?.validationError"
        class="rounded-xl border border-red-500/30 bg-red-500/5 p-3 space-y-1"
      >
        <BaseBadge variant="error">{{ t('share.resourceStatuses.validation_failed') }}</BaseBadge>
        <p class="text-xs text-red-300">{{ editing.validationError }}</p>
      </div>

      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="saving" :disabled="!canSave" @click="submit">{{ t('common.save') }}</BaseButton>
    </template>
  </EntityModal>
</template>
