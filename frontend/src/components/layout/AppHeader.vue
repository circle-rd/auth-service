<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useTheme } from '@/composables/useTheme';
import { useAuthStore } from '@/stores/auth';
import { Sun, Moon, User, LogOut, Menu } from 'lucide-vue-next';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import LanguageSelect from '@/components/ui/LanguageSelect.vue';
import { useMobileNav } from '@/composables/useMobileNav';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const { theme, toggle } = useTheme();
const { toggle: toggleSidebar } = useMobileNav();

defineProps<{
  title?: string;
  subtitle?: string;
}>();

const menuOpen = ref(false);

async function handleLogout() {
  menuOpen.value = false;
  await auth.logout();
  await router.push('/login');
}
</script>

<template>
  <header class="relative z-40 h-16 shrink-0 flex items-center justify-between px-4 md:px-6 border-b border-surface-800/40 bg-surface-950/40 backdrop-blur-xl">
    <!-- Mobile burger button -->
    <button
      @click="toggleSidebar"
      class="md:hidden p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors"
      :aria-label="t('aria.openMenu') || 'Open menu'"
    >
      <Menu class="w-5 h-5" />
    </button>

    <!-- Title section -->
    <div class="flex-1 md:flex-none">
      <h1 v-if="title" class="text-base font-semibold text-surface-100">{{ title }}</h1>
      <p v-if="subtitle" class="text-xs text-surface-500">{{ subtitle }}</p>
    </div>

    <!-- Right actions -->
    <div class="flex items-center gap-1 sm:gap-2 md:gap-3">
      <LanguageSelect />

      <button
        @click="toggle"
        class="p-2 rounded-md text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors"
        :title="theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
      >
        <Sun v-if="theme === 'dark'" class="w-4 h-4" />
        <Moon v-else class="w-4 h-4" />
      </button>

      <!-- User menu -->
      <div class="relative" v-click-outside="() => (menuOpen = false)">
        <button
          type="button"
          @click="menuOpen = !menuOpen"
          class="flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-lg hover:bg-surface-800/60 transition-colors"
          :aria-expanded="menuOpen"
        >
          <UserAvatar :name="auth.user?.name" :image="auth.user?.image" size="sm" />
          <span class="text-sm font-medium text-surface-200 max-w-28 truncate hidden sm:block">{{ auth.user?.name }}</span>
        </button>

        <Transition
          enter-active-class="transition duration-100 ease-out"
          enter-from-class="opacity-0 scale-95 -translate-y-1"
          enter-to-class="opacity-100 scale-100 translate-y-0"
          leave-active-class="transition duration-75 ease-in"
          leave-from-class="opacity-100 scale-100 translate-y-0"
          leave-to-class="opacity-0 scale-95 -translate-y-1"
        >
          <div
            v-if="menuOpen"
            class="absolute right-0 top-full mt-1.5 w-52 bg-surface-900 border border-surface-700/60 rounded-xl shadow-xl overflow-hidden z-50 origin-top-right"
          >
            <!-- Identity header -->
            <div class="px-3.5 py-3 border-b border-surface-800/40">
              <p class="text-sm font-medium text-surface-100 truncate">{{ auth.user?.name }}</p>
              <p class="text-xs text-surface-500 truncate mt-0.5">{{ auth.user?.email }}</p>
            </div>

            <!-- Actions -->
            <div class="py-1">
              <RouterLink
                to="/profile"
                @click="menuOpen = false"
                class="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-surface-300 hover:bg-surface-800/60 hover:text-surface-100 transition-colors"
              >
                <User class="w-4 h-4 shrink-0 text-surface-500" />
                {{ t('nav.profile') }}
              </RouterLink>

              <button
                type="button"
                @click="handleLogout"
                class="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
              >
                <LogOut class="w-4 h-4 shrink-0" />
                {{ t('nav.signOut') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </header>
</template>

