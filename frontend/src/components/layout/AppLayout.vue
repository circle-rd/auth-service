<script setup lang="ts">
import AppSidebar from './AppSidebar.vue';
import AppHeader from './AppHeader.vue';
import ToastContainer from '@/components/ui/ToastContainer.vue';

defineProps<{
  title?: string;
  subtitle?: string;
}>();
</script>

<template>
  <div class="flex h-screen bg-surface-950 text-surface-100 overflow-hidden">
    <AppSidebar />
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <AppHeader :title="title" :subtitle="subtitle" />
      <main class="flex-1 overflow-y-auto">
        <div class="p-6 animate-fade-in">
          <slot />
        </div>
      </main>
    </div>
  </div>
  <ToastContainer />
</template>
