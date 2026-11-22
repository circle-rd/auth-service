<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Camera, Trash2 } from '@lucide/vue';
import EntityIcon from '@/components/ui/EntityIcon.vue';

defineProps<{
  modelValue: string;
  name: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  error: [message: string];
}>();

const { t } = useI18n();
const input = ref<HTMLInputElement | null>(null);
const processing = ref(false);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const LOGO_SIZE = 256;

async function resize(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unreadable image'));
      image.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = LOGO_SIZE;
    canvas.height = LOGO_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');

    const scale = Math.max(
      LOGO_SIZE / image.naturalWidth,
      LOGO_SIZE / image.naturalHeight,
    );
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(
      image,
      (LOGO_SIZE - width) / 2,
      (LOGO_SIZE - height) / 2,
      width,
      height,
    );
    return canvas.toDataURL('image/webp', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function onFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    emit('error', t('organizations.logoInvalid'));
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    emit('error', t('organizations.logoTooLarge'));
    return;
  }
  processing.value = true;
  try {
    emit('update:modelValue', await resize(file));
  } catch {
    emit('error', t('organizations.logoInvalid'));
  } finally {
    processing.value = false;
  }
}

function remove() {
  emit('update:modelValue', '');
}
</script>

<template>
  <div class="relative group w-14 md:w-28 h-14 md:h-28">
    <EntityIcon
      :icon-url="modelValue || null"
      :name="name"
      letter-class="text-xl md:text-5xl"
      class="w-full h-full rounded-xl md:rounded-2xl md:shadow-lg md:shadow-black/40"
    />

    <button
      type="button"
      class="absolute inset-0 flex items-center justify-center rounded-xl md:rounded-2xl bg-black/55 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      :aria-label="t('organizations.changeLogo')"
      :disabled="processing"
      @click="input?.click()"
    >
      <Camera class="w-5 h-5 md:w-7 md:h-7" />
    </button>

    <button
      v-if="modelValue"
      type="button"
      class="absolute -top-1.5 -right-1.5 p-1 rounded-full bg-surface-900 border border-surface-700 text-surface-400 hover:text-red-400 hover:border-red-500/40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      :aria-label="t('organizations.removeLogo')"
      @click.stop="remove"
    >
      <Trash2 class="w-3.5 h-3.5" />
    </button>

    <input
      ref="input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      class="hidden"
      @change="onFile"
    />
  </div>
</template>
