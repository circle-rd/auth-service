<script setup lang="ts">
import AppHeader from './AppHeader.vue';
import ToastContainer from '@/components/ui/ToastContainer.vue';

defineProps<{
  title?: string;
  subtitle?: string;
}>();
</script>

<template>
  <div class="flex flex-col h-screen bg-surface-950 text-surface-100 overflow-hidden">
    <AppHeader :title="title" :subtitle="subtitle" brand />
    <main class="flex-1 overflow-y-auto">
      <div class="max-w-6xl 2xl:max-w-7xl mx-auto px-4 py-4 sm:px-6 sm:py-6 animate-fade-in">
        <div class="rounded-2xl border border-surface-700/60 bg-surface-900/60 overflow-hidden flex flex-col lg:flex-row">
          <aside
            v-if="$slots.identity"
            class="shrink-0 border-b border-surface-800/60 bg-surface-950/30 lg:w-[21rem] xl:w-[23rem] lg:border-b-0 lg:border-r"
          >
            <slot name="identity" />
          </aside>
          <section class="flex-1 min-w-0 p-4 sm:p-6">
            <slot />
          </section>
        </div>
      </div>
    </main>
  </div>
  <ToastContainer />
</template>
