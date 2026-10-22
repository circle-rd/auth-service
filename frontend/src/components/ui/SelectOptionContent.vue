<script setup lang="ts">
import type { SelectOption } from '@/types/select';
import UserAvatar from './UserAvatar.vue';

withDefaults(defineProps<{
  option: SelectOption;
  showDescription?: boolean;
}>(), {
  showDescription: true,
});
</script>

<template>
  <span class="flex items-center gap-2.5 min-w-0">
    <UserAvatar v-if="option.avatar" :name="option.avatar.name" :image="option.avatar.image" size="xs" />
    <span
      v-else-if="option.icon"
      class="w-6 h-6 shrink-0 rounded-md bg-surface-700/60 border border-surface-600/50 flex items-center justify-center text-surface-400"
    >
      <component :is="option.icon" class="w-3.5 h-3.5" />
    </span>
    <span class="flex flex-col min-w-0 text-left">
      <span class="truncate leading-tight">{{ option.label }}</span>
      <span v-if="showDescription && option.description" class="truncate text-xs text-surface-500 leading-tight mt-0.5">
        {{ option.description }}
      </span>
    </span>
  </span>
</template>
