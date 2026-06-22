import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

const isSidebarOpen = ref(false);

/**
 * Mobile navigation state composable
 * Manages sidebar drawer open/close state with auto-close on route change,
 * resize detection, and ESC key handling.
 */
export function useMobileNav() {
  const router = useRouter();

  const open = () => {
    isSidebarOpen.value = true;
  };

  const close = () => {
    isSidebarOpen.value = false;
  };

  const toggle = () => {
    isSidebarOpen.value = !isSidebarOpen.value;
  };

  // Auto-close sidebar on route change
  watch(() => router.currentRoute.value.fullPath, () => {
    close();
  });

  // Auto-close when resizing above md breakpoint (768px)
  const handleResize = () => {
    if (window.innerWidth >= 768) {
      close();
    }
  };

  // ESC key closes the drawer
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
    }
  };

  onMounted(() => {
    // Ensure drawer is always closed when mounting on mobile viewports.
    if (window.innerWidth < 768) {
      close();
    }

    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeydown);
  });

  onUnmounted(() => {
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('keydown', handleKeydown);
  });

  return {
    isSidebarOpen,
    open,
    close,
    toggle,
  };
}
