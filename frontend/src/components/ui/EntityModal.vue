<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import BaseBadge from './BaseBadge.vue';

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

const iconLetterDisplay = computed(() => {
  if (props.iconLetter) return props.iconLetter;
  if (props.name) return props.name[0].toUpperCase();
  return '?';
});

const defaultColors = [
  'from-blue-600/30 to-blue-800/20 border-blue-700/30 text-blue-300',
  'from-emerald-600/30 to-emerald-800/20 border-emerald-700/30 text-emerald-300',
  'from-amber-600/30 to-amber-800/20 border-amber-700/30 text-amber-300',
  'from-rose-600/30 to-rose-800/20 border-rose-700/30 text-rose-300',
  'from-teal-600/30 to-teal-800/20 border-teal-700/30 text-teal-300',
  'from-sky-600/30 to-sky-800/20 border-sky-700/30 text-sky-300',
];

const autoIconColor = computed(() => {
  if (props.iconColor) return props.iconColor;
  const letter = iconLetterDisplay.value;
  const idx = letter.charCodeAt(0) % defaultColors.length;
  return defaultColors[idx];
});
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
            :class="['relative w-full bg-surface-900 border border-surface-700/60 shadow-2xl shadow-black/60 overflow-hidden', sizeClasses[size]]"
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

            <div class="flex items-start gap-5 px-6 pt-6 pb-5 border-b border-surface-800/60 bg-surface-950/40">
              <div
                :class="[
                  'w-16 h-16 shrink-0 overflow-hidden flex items-center justify-center border bg-gradient-to-br',
                  iconShape === 'circle' ? 'rounded-full' : 'rounded-lg',
                  !iconUrl ? autoIconColor : 'bg-surface-800 border-surface-700/50',
                ]"
              >
                <img v-if="iconUrl" :src="iconUrl" class="w-full h-full object-cover" :alt="name ?? ''" />
                <span v-else class="text-2xl font-bold select-none">{{ iconLetterDisplay }}</span>
              </div>

              <div class="flex-1 min-w-0 pt-0.5">
                <h2 class="text-xl font-bold text-surface-50 leading-tight truncate">
                  {{ name && name.length ? name : 'New Entity' }}
                </h2>
                <p v-if="subtitle" class="text-sm font-mono text-surface-500 mt-0.5 truncate">{{ subtitle }}</p>
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

            <div class="px-6 py-5 max-h-[60vh] overflow-y-auto">
              <slot />
            </div>

            <div v-if="$slots.footer" class="px-6 py-4 flex justify-end gap-2.5 border-t border-surface-800/60 bg-surface-950/20">
              <slot name="footer" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
