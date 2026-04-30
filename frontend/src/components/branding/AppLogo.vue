<script setup lang="ts">
import { computed } from 'vue';
import { Shield } from 'lucide-vue-next';
import { useAppBranding } from '@/composables/useAppBranding';

interface Props {
  size?: number;
  alt?: string;
  iconClass?: string;
}
const props = withDefaults(defineProps<Props>(), { size: 20, alt: '' });
const { branding } = useAppBranding();
const altText = computed(() => props.alt || branding.value.appName);
</script>

<template>
  <img
    v-if="branding.logoUrl"
    :src="branding.logoUrl"
    :alt="altText"
    :width="size"
    :height="size"
    class="object-contain"
  />
  <Shield v-else :class="iconClass" :style="{ width: `${size}px`, height: `${size}px` }" />
</template>
