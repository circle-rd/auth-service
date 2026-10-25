<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import BaseBadge from './BaseBadge.vue';
import EntityIcon from './EntityIcon.vue';

type BadgeVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary';
type IconShape = 'circle' | 'square';

const props = withDefaults(defineProps<{
  open: boolean;
  iconUrl?: string | null;
  iconLetter?: string;
  iconColor?: string;
  iconShape?: IconShape;
  name?: string;
  subtitle?: string;
  tags?: Array<{ label: string; variant: BadgeVariant }>;
  size?: 'md' | 'lg' | 'xl';
  accentColor?: string;
}>(), {
  iconShape: 'square',
  size: 'lg',
});

const emit = defineEmits<{ close: [] }>();

const sizeClasses = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
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
        <div class="absolute inset-0 bg-black/75 backdrop-blur-sm" />

        <Transition
          enter-active-class="duration-250 ease-out"
          enter-from-class="opacity-0 scale-[0.97] translate-y-3"
          enter-to-class="opacity-100 scale-100 translate-y-0"
          leave-active-class="duration-150 ease-in"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-[0.97]"
          appear
        >
          <div
            v-if="open"
            :class="['relative w-full mx-4 sm:mx-6 md:mx-auto bg-surface-900 border border-surface-700/60 shadow-2xl shadow-black/60 overflow-hidden max-h-[90vh] overflow-y-auto flex flex-col', sizeClasses[size]]"
            style="border-radius: 10px;"
          >
            <button
              @click="emit('close')"
              class="absolute top-4 right-4 z-10 p-1.5 rounded-md text-surface-500 hover:text-surface-200 hover:bg-surface-700/60 transition-colors"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div class="flex items-start gap-4 sm:gap-5 px-4 sm:px-6 pt-6 pb-5 border-b border-surface-800/60 bg-surface-950/40 shrink-0">
              <EntityIcon
                :icon-url="iconUrl"
                :letter="iconLetter"
                :name="name"
                :color="iconColor"
                :shape="iconShape"
                class="w-14 sm:w-16 h-14 sm:h-16"
              />

              <div class="flex-1 min-w-0 pt-0.5">
                <h2 class="text-lg sm:text-xl font-bold text-surface-50 leading-tight truncate">
                  {{ name && name.length ? name : 'New Entity' }}
                </h2>
                <p v-if="subtitle" class="text-xs sm:text-sm font-mono text-surface-500 mt-0.5 truncate">{{ subtitle }}</p>
                <div v-if="tags?.length" class="flex flex-wrap gap-1.5 mt-2.5">
                  <BaseBadge
                    v-for="tag in tags"
                    :key="tag.label"
                    :variant="tag.variant"
                    size="sm"
                  >
                    {{ tag.label }}
                  </BaseBadge>
                </div>
              </div>
            </div>

            <div class="px-4 sm:px-6 py-5 overflow-y-auto">
              <slot />
            </div>

            <div v-if="$slots.footer" class="px-4 sm:px-6 py-4 flex justify-end gap-2.5 border-t border-surface-800/60 bg-surface-950/20 shrink-0">
              <slot name="footer" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
