<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}>(), {
  size: 'md',
});

const emit = defineEmits<{ close: [] }>();

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        @click.self="emit('close')"
      >
        <div class="absolute inset-0 bg-surface-950/80 backdrop-blur-sm" />
        <Transition
          enter-active-class="duration-200 ease-out"
          enter-from-class="opacity-0 scale-95 translate-y-2"
          enter-to-class="opacity-100 scale-100 translate-y-0"
          leave-active-class="duration-150 ease-in"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-95"
          appear
        >
          <div
            v-if="open"
            :class="['relative w-full rounded-xl bg-surface-900 border border-surface-700/50 shadow-2xl shadow-black/50', sizeClasses[size]]"
          >
            <div v-if="title || $slots.header" class="flex items-center justify-between px-6 py-4 border-b border-surface-700/50">
              <slot name="header">
                <h2 class="text-base font-semibold text-surface-100">{{ title }}</h2>
              </slot>
              <button
                @click="emit('close')"
                class="p-1 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors"
              >
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div class="px-6 py-5">
              <slot />
            </div>
            <div v-if="$slots.footer" class="px-6 pb-5 flex justify-end gap-3">
              <slot name="footer" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
