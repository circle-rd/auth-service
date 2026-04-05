<script setup lang="ts">
  import { ref, computed, onMounted, onUnmounted } from "vue";
  import { useRouter, RouterLink } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { LogOut, User, Shield, Sun, Moon, ChevronDown } from "lucide-vue-next";
  import { useAuthStore } from "../stores/auth.js";

  const { t } = useI18n();
  const authStore = useAuthStore();
  const router = useRouter();

  const isDark = ref(document.documentElement.classList.contains("dark"));
  const userMenuOpen = ref(false);
  const menuRef = ref<HTMLElement | null>(null);

  function toggleTheme() {
    isDark.value = !isDark.value;
    if (isDark.value) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }

  async function handleSignOut() {
    userMenuOpen.value = false;
    await authStore.signOut();
    await router.push("/login");
  }

  function handleClickOutside(e: MouseEvent) {
    if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
      userMenuOpen.value = false;
    }
  }

  onMounted(() => document.addEventListener("click", handleClickOutside));
  onUnmounted(() => document.removeEventListener("click", handleClickOutside));

  const isAdmin = computed(() => {
    const role = authStore.user?.role as string | undefined;
    return role === "admin" || role === "superadmin";
  });

  const userInitial = computed(() => {
    const name = authStore.user?.name;
    return name ? name.charAt(0).toUpperCase() : "?";
  });
</script>

<template>
  <nav class="fixed top-0 left-0 right-0 z-50 nav-glass">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-14">

        <!-- Logo -->
        <RouterLink to="/" class="nav-logo">
          <div class="nav-logo-icon">
            <Shield class="w-4 h-4" />
          </div>
          <span class="nav-logo-text">
            Auth<span style="font-weight: 600">Service</span>
          </span>
        </RouterLink>

        <!-- Right actions -->
        <div class="flex items-center gap-1">

          <!-- Theme toggle -->
          <button class="btn btn-ghost nav-icon-btn" @click="toggleTheme" :title="t('nav.toggleTheme')">
            <Moon v-if="!isDark" class="w-4 h-4" />
            <Sun v-else class="w-4 h-4" />
          </button>

          <!-- User menu (authenticated only) -->
          <div v-if="authStore.isAuthenticated" ref="menuRef" class="relative">
            <button class="nav-user-btn" :class="{ 'nav-user-btn--open': userMenuOpen }"
              @click="userMenuOpen = !userMenuOpen">
              <div class="nav-avatar">{{ userInitial }}</div>
              <ChevronDown class="w-3.5 h-3.5 transition-transform duration-200"
                :style="{ transform: userMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }" />
            </button>

            <!-- Dropdown -->
            <div v-if="userMenuOpen" class="dropdown-menu">
              <!-- User info header -->
              <div class="px-3 py-2.5">
                <p class="text-xs font-semibold" style="color: var(--color-text)">
                  {{ authStore.user?.name }}
                </p>
                <p class="text-xs mt-0.5 truncate" style="color: var(--color-text-muted); max-width: 11rem">
                  {{ authStore.user?.email }}
                </p>
              </div>

              <div class="dropdown-divider" />

              <RouterLink to="/profile" class="dropdown-item" @click="userMenuOpen = false">
                <User class="w-3.5 h-3.5 shrink-0" />
                {{ t("nav.profile") }}
              </RouterLink>

              <RouterLink v-if="isAdmin" to="/admin/users" class="dropdown-item" @click="userMenuOpen = false">
                <Shield class="w-3.5 h-3.5 shrink-0" />
                {{ t("nav.admin") }}
              </RouterLink>

              <div class="dropdown-divider" />

              <button class="dropdown-item dropdown-item-danger" @click="handleSignOut">
                <LogOut class="w-3.5 h-3.5 shrink-0" />
                {{ t("nav.signOut") }}
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
  .nav-logo {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    text-decoration: none;
  }

  .nav-logo-icon {
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .nav-logo-text {
    font-weight: 300;
    color: var(--color-text);
    font-size: 0.9rem;
    letter-spacing: -0.01em;
  }

  .nav-icon-btn {
    padding: 0.5rem;
  }

  .nav-user-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-radius: 4px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    transition: background 0.15s ease;
  }

  .nav-user-btn:hover,
  .nav-user-btn--open {
    background: var(--color-bg);
    color: var(--color-text);
  }

  html.dark .nav-user-btn:hover,
  html.dark .nav-user-btn--open {
    background: var(--color-surface);
  }

  .nav-avatar {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
    flex-shrink: 0;
  }
</style>
