<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import BaseInput from '@/components/ui/BaseInput.vue';
import type { ApplicationFormState } from './state';

defineProps<{
  form: ApplicationFormState;
  isEdit: boolean;
  iconAutoDetected: boolean;
}>();

const emit = defineEmits<{
  'url-input': [];
  'url-blur': [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <BaseInput v-model="form.name" :label="t('applications.name')" required />
      <BaseInput v-model="form.slug" :label="t('applications.slug')" :disabled="isEdit" required />
    </div>
    <BaseInput v-model="form.description" :label="t('applications.description')" />
    <BaseInput
      v-model="form.url"
      :label="t('applications.url')"
      placeholder="https://app.example.com"
      @update:model-value="emit('url-input')"
      @blur="emit('url-blur')"
    />
    <BaseInput
      v-model="form.icon"
      :label="t('applications.icon')"
      placeholder="https://..."
      :hint="iconAutoDetected ? t('applications.iconDetected') : undefined"
    />
  </div>
</template>
