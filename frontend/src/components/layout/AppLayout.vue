<script setup lang="ts">
import { watch } from 'vue';
import AppSidebar from './AppSidebar.vue';
import AppHeader from './AppHeader.vue';
import ToastContainer from '@/components/ui/ToastContainer.vue';
import { useMobileNav } from '@/composables/useMobileNav';

defineProps<{
  title?: string;
  subtitle?: string;
}>();

const { isSidebarOpen, close } = useMobileNav();

// Lock body scroll when sidebar is open on mobile
watch(isSidebarOpen, (isOpen) => {
  if (window.innerWidth < 768) {
    if (isOpen) {
      document.documentElement.classList.add('overflow-hidden');
    } else {
      document.documentElement.classList.remove('overflow-hidden');
    }
  }
});
</script>

<template>
  <div class="flex h-screen bg-surface-950 text-surface-100 overflow-hidden">
    <!-- Mobile sidebar backdrop -->
    <transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isSidebarOpen"
        @click="close"
        class="md:hidden fixed inset-0 bg-black/40 z-30"
      />
    </transition>

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
