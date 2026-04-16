import { createI18n } from 'vue-i18n';
import en from './en';
import fr from './fr';

const STORAGE_KEY = 'locale';

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

export function setLocale(locale: 'en' | 'fr') {
  (i18n.global.locale as { value: string }).value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}
