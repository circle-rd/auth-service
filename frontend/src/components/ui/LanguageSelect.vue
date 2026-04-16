<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '@/i18n';

const { locale } = useI18n();
const open = ref(false);

const current = () => availableLocales.find(l => l.code === locale.value) ?? availableLocales[0];

function select(code: LocaleCode) {
  setLocale(code);
  open.value = false;
}
</script>

<template>
  <div class="relative" v-click-outside="() => (open = false)">
    <button
      type="button"
      @click="open = !open"
      class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors select-none"
      :aria-expanded="open"
      aria-haspopup="listbox"
    >
      <span class="text-base leading-none">{{ current().flag }}</span>
      <span class="uppercase tracking-wide">{{ current().code }}</span>
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 scale-95 -translate-y-1"
      enter-to-class="opacity-100 scale-100 translate-y-0"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 scale-100 translate-y-0"
      leave-to-class="opacity-0 scale-95 -translate-y-1"
    >
      <ul
        v-if="open"
        role="listbox"
        class="absolute right-0 top-full mt-1.5 w-36 bg-surface-900 border border-surface-700/60 rounded-xl shadow-xl overflow-hidden z-50 origin-top-right"
      >
        <li
          v-for="loc in availableLocales"
          :key="loc.code"
          role="option"
          :aria-selected="locale === loc.code"
          @click="select(loc.code)"
          class="flex items-center gap-2.5 px-3 py-2.5 text-sm cursor-pointer transition-colors"
          :class="locale === loc.code
            ? 'bg-primary-600/15 text-primary-300'
            : 'text-surface-300 hover:bg-surface-800/60 hover:text-surface-100'"
        >
          <span class="text-base leading-none">{{ loc.flag }}</span>
          <span class="flex-1">{{ loc.label }}</span>
          <svg v-if="locale === loc.code" class="w-3.5 h-3.5 text-primary-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </li>
      </ul>
    </Transition>
  </div>
</template>
