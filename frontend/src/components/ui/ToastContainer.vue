<script setup lang="ts">
import { useToast } from '@/composables/useToast';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-vue-next';

const { toasts, remove } = useToast();

const icons = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const classes = {
  success: 'border-emerald-500/30 bg-surface-900 text-emerald-400',
  error: 'border-red-500/30 bg-surface-900 text-red-400',
  warning: 'border-amber-500/30 bg-surface-900 text-amber-400',
  info: 'border-sky-500/30 bg-surface-900 text-sky-400',
};
</script>

<template>
  <Teleport to="body">
    <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full">
      <TransitionGroup
        enter-active-class="transition-all duration-300 ease-out"
        enter-from-class="opacity-0 translate-x-8"
        enter-to-class="opacity-100 translate-x-0"
        leave-active-class="transition-all duration-200 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0 scale-95"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          :class="['flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm', classes[toast.type]]"
        >
          <component :is="icons[toast.type]" class="w-4 h-4 mt-0.5 shrink-0" />
          <p class="text-sm text-surface-200 flex-1">{{ toast.message }}</p>
          <button @click="remove(toast.id)" class="shrink-0 text-surface-500 hover:text-surface-300 transition-colors">
            <X class="w-4 h-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
