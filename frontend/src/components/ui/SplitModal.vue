<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import BaseBadge from './BaseBadge.vue';
import EntityIcon from './EntityIcon.vue';

type BadgeVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary';

const props = defineProps<{
  open: boolean;
  iconUrl?: string | null;
  iconLetter?: string;
  name?: string;
  subtitle?: string;
  tags?: Array<{ label: string; variant: BadgeVariant }>;
  details?: Array<{ label: string; value: string }>;
}>();

const emit = defineEmits<{ close: [] }>();

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
            class="relative w-full max-w-5xl bg-surface-900 border border-surface-700/60 shadow-2xl shadow-black/60 overflow-hidden flex flex-col md:flex-row max-h-[90vh] md:h-[min(90vh,760px)] rounded-[10px]"
          >
            <button
              type="button"
              @click="emit('close')"
              class="absolute top-4 right-4 z-10 p-1.5 rounded-md text-surface-500 hover:text-surface-200 hover:bg-surface-700/60 transition-colors"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <!-- Identity panel -->
            <aside
              class="shrink-0 md:w-1/3 flex md:flex-col items-center md:items-stretch gap-4 px-5 sm:px-6 py-5 md:px-8 md:pt-14 md:pb-8 pr-14 md:pr-8 border-b md:border-b-0 md:border-r border-surface-800/60 bg-surface-950/40 md:overflow-y-auto"
            >
              <div class="md:flex md:justify-center">
                <EntityIcon
                  :icon-url="iconUrl"
                  :letter="iconLetter"
                  :name="name"
                  letter-class="text-xl md:text-5xl"
                  class="w-14 md:w-28 h-14 md:h-28 md:rounded-2xl md:shadow-lg md:shadow-black/40"
                />
              </div>
              <div class="min-w-0 w-full md:mt-3">
                <h2 class="text-lg md:text-xl font-bold text-surface-50 leading-tight break-words">
                  {{ name && name.length ? name : 'New Entity' }}
                </h2>
                <p v-if="subtitle" class="text-xs md:text-sm font-mono text-surface-500 mt-1 break-all">{{ subtitle }}</p>
                <div v-if="tags?.length" class="flex flex-wrap gap-1.5 mt-3">
                  <BaseBadge v-for="tag in tags" :key="tag.label" :variant="tag.variant" size="sm">
                    {{ tag.label }}
                  </BaseBadge>
                </div>
                <dl v-if="details?.length" class="hidden md:block mt-6 pt-5 border-t border-surface-800/60 space-y-4">
                  <div v-for="detail in details" :key="detail.label">
                    <dt class="text-[11px] font-medium text-surface-500 uppercase tracking-wider">{{ detail.label }}</dt>
                    <dd class="mt-1 text-sm text-surface-300 break-words line-clamp-4">{{ detail.value }}</dd>
                  </div>
                </dl>
              </div>
            </aside>

            <!-- Content -->
            <div class="flex-1 min-w-0 min-h-0 flex flex-col">
              <slot />
              <div v-if="$slots.footer" class="px-4 sm:px-6 py-4 flex justify-end gap-2.5 border-t border-surface-800/60 bg-surface-950/20 shrink-0">
                <slot name="footer" />
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
