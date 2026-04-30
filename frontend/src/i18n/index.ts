import { createI18n } from 'vue-i18n';
import en from './en';
import fr from './fr';

const STORAGE_KEY = 'locale';

export const availableLocales = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
] as const;

export type LocaleCode = typeof availableLocales[number]['code'];

function getInitialLocale(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'fr') return stored;
  const browser = navigator.language.startsWith('fr') ? 'fr' : 'en';
  return browser;
}

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'en',
  messages: { en, fr },
});

export function setLocale(locale: LocaleCode) {
  (i18n.global.locale as { value: string }).value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}
