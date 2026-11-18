<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseInput from './BaseInput.vue';
import SchemeIcon from './SchemeIcon.vue';
import { SCHEME_ICON_CHOICES, isIconUrl } from '@/utils/schemeIcons';

const model = defineModel<string>({ required: true });

defineProps<{ label: string; scheme?: string }>();

const { t } = useI18n();
const names = Object.keys(SCHEME_ICON_CHOICES);
const urlValue = computed(() => (isIconUrl(model.value) ? model.value : ''));

function setUrl(value: string) {
  model.value = value;
}
</script>

<template>
  <div class="space-y-2">
    <p class="text-xs font-medium text-surface-400 uppercase tracking-wide">{{ label }}</p>
    <div class="flex flex-wrap gap-1.5" role="radiogroup" :aria-label="label">
      <button
        v-for="name in names"
        :key="name"
        type="button"
        role="radio"
        :aria-checked="model === name"
        :title="name"
        :class="[
          'p-1 rounded-xl border transition-colors',
          model === name
            ? 'border-primary-500/60 bg-primary-600/15'
            : 'border-transparent hover:bg-surface-800/60',
        ]"
        @click="model = name"
      >
        <SchemeIcon :icon="name" :scheme="scheme" size="sm" />
      </button>
    </div>
    <BaseInput
      :model-value="urlValue"
      :label="t('share.schemes.iconUrl')"
      :hint="t('share.schemes.iconUrlHint')"
      placeholder="https://"
      @update:model-value="setUrl"
    />
  </div>
</template>
