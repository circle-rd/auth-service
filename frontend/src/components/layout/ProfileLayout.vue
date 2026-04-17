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
    <AppHeader :title="title" :subtitle="subtitle" />
    <main class="flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto px-6 py-6 animate-fade-in">
        <slot />
      </div>
    </main>
  </div>
  <ToastContainer />
</template>
