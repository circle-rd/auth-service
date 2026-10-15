<script setup lang="ts">
import { computed } from 'vue';
import CircleMark from '@/components/branding/CircleMark.vue';
import { useAppBranding } from '@/composables/useAppBranding';
import { useLogoTone } from '@/composables/useLogoTone';
import { useTheme } from '@/composables/useTheme';

interface Props {
  size?: number;
  alt?: string;
  iconClass?: string;
}
const props = withDefaults(defineProps<Props>(), { size: 20, alt: '' });
const { branding } = useAppBranding();
const { tone } = useLogoTone();
const { theme } = useTheme();
const logoSrc = computed(
  () =>
    (theme.value === 'dark' ? branding.value.logoDarkUrl : null) ?? branding.value.logoUrl ?? undefined,
);
const altText = computed(() => props.alt || branding.value.appName);

// Installations ship their own logo. Black or white ones are inverted when they
// would vanish on the current theme; other transparent ones get an avatar-style
// circle in the opposite tone of the theme.
const isLight = computed(() => theme.value === 'light');
const inverted = computed(
  () => (isLight.value && tone.value === 'light') || (!isLight.value && tone.value === 'dark'),
);
const circled = computed(() => tone.value === 'color');
const imgClass = computed(() => [
  'object-contain',
  inverted.value && 'invert',
  circled.value && ['rounded-full', isLight.value ? 'bg-zinc-900' : 'bg-zinc-100'],
]);
const imgStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  // Keeps a square logo clear of the circle clipping its corners.
  padding: circled.value ? `${Math.round(props.size * 0.18)}px` : undefined,
}));
</script>

<template>
  <img
    v-if="branding.logoUrl"
    :src="logoSrc"
    :alt="altText"
    :width="size"
    :height="size"
    :style="imgStyle"
    :class="imgClass"
  />
  <CircleMark v-else :class="iconClass" :style="{ width: `${size}px`, height: `${size}px` }" />
</template>
