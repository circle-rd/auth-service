<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  passwordStrength,
  MIN_PASSWORD_LENGTH,
  type PasswordStrengthLevel,
} from '@/utils/passwordStrength';

const props = defineProps<{ password: string }>();

const { t } = useI18n();

const strength = computed(() => passwordStrength(props.password));

// Same colour vocabulary as BaseBadge (emerald / red / amber / sky), applied
// to the bar fill so the meter follows the active theme's surface scale on the
// unfilled bars.
const barClasses: Record<PasswordStrengthLevel, string> = {
  weak: 'bg-red-500',
  fair: 'bg-amber-500',
  good: 'bg-sky-500',
  strong: 'bg-emerald-500',
};

const labelClasses: Record<PasswordStrengthLevel, string> = {
  weak: 'text-red-400',
  fair: 'text-amber-400',
  good: 'text-sky-400',
  strong: 'text-emerald-400',
};

const hint = computed(() =>
  strength.value.acceptable
    ? t('auth.passwordStrength.hint')
    : t('auth.passwordTooShort', { min: MIN_PASSWORD_LENGTH }),
);
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex items-center gap-1.5" role="presentation">
      <span
        v-for="bar in 4"
        :key="bar"
        :class="[
          'h-1 flex-1 rounded-full transition-colors duration-150',
          bar <= strength.score && strength.level
            ? barClasses[strength.level]
            : 'bg-surface-700',
        ]"
      />
    </div>
    <p
      v-if="strength.level"
      :class="['text-xs', labelClasses[strength.level]]"
    >
      {{ t(`auth.passwordStrength.${strength.level}`) }}
    </p>
    <p v-else class="text-xs text-surface-500">{{ hint }}</p>
  </div>
</template>
