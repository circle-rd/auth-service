import { ref } from 'vue';

const isSidebarOpen = ref(false);
const isSidebarCollapsed = ref(false);

const MOBILE_BREAKPOINT = 768;
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'auth-service:sidebar-collapsed';

let initialized = false;

function initSidebarState() {
  if (initialized || typeof window === 'undefined') return;

  initialized = true;

  const persisted = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
  isSidebarCollapsed.value = persisted === '1';

  // Drawer must never start open on mobile.
  if (window.innerWidth < MOBILE_BREAKPOINT) {
    isSidebarOpen.value = false;
  }
}

function persistCollapsedState() {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    isSidebarCollapsed.value ? '1' : '0'
  );
}

/**
 * Mobile navigation state composable
 * Manages sidebar drawer state for mobile and collapsed state for desktop.
 */
export function useMobileNav() {
  initSidebarState();

  const isMobileViewport = () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT;

  const open = () => {
    if (isMobileViewport()) {
      isSidebarOpen.value = true;
    }
  };

  const close = () => {
    isSidebarOpen.value = false;
  };

  const toggle = () => {
    if (isMobileViewport()) {
      isSidebarOpen.value = !isSidebarOpen.value;
    }
  };

  const setCollapsed = (collapsed: boolean) => {
    isSidebarCollapsed.value = collapsed;
    persistCollapsedState();
  };

  const toggleCollapsed = () => {
    setCollapsed(!isSidebarCollapsed.value);
  };

  const syncForViewport = () => {
    if (typeof window === 'undefined') return;

    if (window.innerWidth >= MOBILE_BREAKPOINT) {
      close();
    }
  };

  return {
    isSidebarOpen,
    isSidebarCollapsed,
    open,
    close,
    toggle,
    setCollapsed,
    toggleCollapsed,
    syncForViewport,
  };
}
