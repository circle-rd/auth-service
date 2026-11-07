<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Link2, Trash2, UserRound } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import { updateMyProfile } from '@/api/users';
import { useToast } from '@/composables/useToast';

const props = defineProps<{
  open: boolean;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [value: string | null];
}>();

const { t } = useI18n();
const toast = useToast();

type AvatarMode = 'gravatar' | 'custom' | 'none';

const mode = ref<AvatarMode>('gravatar');
const customUrl = ref('');
const emailHash = ref('');
const loading = ref(false);
const error = ref('');

const gravatarUrl = computed(() =>
  emailHash.value
    ? `https://www.gravatar.com/avatar/${emailHash.value}?d=identicon&s=256&r=g`
    : null,
);

const preview = computed(() => {
  if (mode.value === 'gravatar') return gravatarUrl.value;
  if (mode.value === 'custom') return safeHttpUrl(customUrl.value);
  return null;
});

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  if (!value || !globalThis.crypto?.subtle) return '';
  const data = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    error.value = '';
    loading.value = false;
    customUrl.value = '';
    emailHash.value = await sha256(props.email ?? '');

    if (props.image && /gravatar\.com\/avatar\//.test(props.image)) {
      mode.value = 'gravatar';
    } else if (props.image) {
      mode.value = 'custom';
      customUrl.value = props.image;
    } else {
      mode.value = 'gravatar';
    }
  },
);

async function save() {
  error.value = '';
  let image: string | null;
  if (mode.value === 'gravatar') {
    if (!gravatarUrl.value) {
      error.value = t('profile.avatarEmailRequired');
      return;
    }
    image = gravatarUrl.value;
  } else if (mode.value === 'custom') {
    image = safeHttpUrl(customUrl.value);
    if (!image) {
      error.value = t('profile.avatarInvalidUrl');
      return;
    }
  } else {
    image = null;
  }

  loading.value = true;
  try {
    await updateMyProfile({ image });
    emit('saved', image);
    emit('close');
    toast.success(t('profile.avatarSaved'));
  } catch (err) {
    toast.error(
      err instanceof Error ? err.message : t('profile.avatarSaveFailed'),
    );
  } finally {
    loading.value = false;
  }
}

const options = computed(() => [
  {
    value: 'gravatar' as const,
    label: t('profile.avatarGravatar'),
    description: t('profile.avatarGravatarHint'),
    icon: UserRound,
    disabled: !gravatarUrl.value,
  },
  {
    value: 'custom' as const,
    label: t('profile.avatarCustom'),
    description: t('profile.avatarCustomHint'),
    icon: Link2,
    disabled: false,
  },
  {
    value: 'none' as const,
    label: t('profile.avatarNone'),
    description: t('profile.avatarNoneHint'),
    icon: Trash2,
    disabled: false,
  },
]);
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('profile.avatarModalTitle')"
    @close="emit('close')"
  >
    <div class="space-y-5">
      <div class="flex flex-col items-center gap-3 text-center">
        <UserAvatar :name="name" :image="preview" size="xl" />
        <div>
          <p class="text-sm font-medium text-surface-200">
            {{ t('profile.avatarPreview') }}
          </p>
          <p class="text-xs text-surface-500 mt-0.5">
            {{ t('profile.avatarPreviewHint') }}
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          :disabled="option.disabled"
          :class="[
            'relative flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            mode === option.value
              ? 'border-primary-500/60 bg-primary-600/10'
              : 'border-surface-700/60 bg-surface-800/40 hover:border-surface-600',
          ]"
          @click="mode = option.value"
        >
          <component :is="option.icon" class="w-4 h-4 text-surface-400" />
          <span class="text-sm font-medium text-surface-200">{{ option.label }}</span>
          <span class="text-xs text-surface-500">{{ option.description }}</span>
          <Check
            v-if="mode === option.value"
            class="absolute top-3 right-3 w-4 h-4 text-primary-400"
          />
        </button>
      </div>

      <div v-if="mode === 'custom'" class="space-y-2">
        <BaseInput
          v-model="customUrl"
          :label="t('profile.avatarUrl')"
          type="url"
          placeholder="https://example.com/avatar.png"
          :error="error || undefined"
        />
        <p class="text-xs text-surface-500">{{ t('profile.avatarUrlHint') }}</p>
      </div>
      <p v-else-if="error" class="text-xs text-red-400">{{ error }}</p>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">
        {{ t('common.cancel') }}
      </BaseButton>
      <BaseButton :loading="loading" @click="save">
        {{ t('common.save') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
