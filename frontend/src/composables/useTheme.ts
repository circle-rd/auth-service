import { ref, watch } from 'vue';

const STORAGE_KEY = 'theme';
type Theme = 'dark' | 'light';

function getInitial(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const theme = ref<Theme>(getInitial());

watch(theme, (val) => {
  localStorage.setItem(STORAGE_KEY, val);
  if (val === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}, { immediate: true });

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  return { theme, toggle };
}
