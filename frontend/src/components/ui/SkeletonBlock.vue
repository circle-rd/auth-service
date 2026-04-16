<script setup lang="ts">
withDefaults(defineProps<{
  width?: string;
  height?: string;
  rounded?: string;
}>(), {
  rounded: 'rounded-lg',
});
</script>

<template>
  <div
    :style="{ width, height }"
    :class="[
      'bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer',
      rounded,
    ]"
  />
</template>
