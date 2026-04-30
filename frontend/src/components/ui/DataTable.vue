<script setup lang="ts">
withDefaults(defineProps<{
  loading?: boolean;
  empty?: boolean;
  skeletonRows?: number;
  skeletonCols?: number;
}>(), {
  loading: false,
  empty: false,
  skeletonRows: 5,
  skeletonCols: 4,
});
</script>

<template>
  <div class="rounded-xl overflow-hidden border border-surface-700/50 bg-surface-900/40">
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead>
          <tr class="border-b border-surface-700/50 bg-surface-800/30">
            <slot name="head" />
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in skeletonRows" :key="i" class="border-b border-surface-800/50 last:border-0">
            <td v-for="j in skeletonCols" :key="j" class="px-4 py-3">
              <div class="h-4 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-md" :style="{ width: j === 1 ? '140px' : '90px' }" />
            </td>
          </tr>
        </tbody>
        <tbody v-else-if="empty">
          <tr>
            <td :colspan="skeletonCols" class="py-0">
              <slot name="empty" />
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <slot />
        </tbody>
      </table>
    </div>
  </div>
</template>
