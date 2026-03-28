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
      <div class="flex items-center justify-between h-16">

        <!-- Logo -->
        <RouterLink to="/" class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center"
            style="background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.15)">
            <Shield class="w-4 h-4" style="color: var(--accent-cyan)" />
          </div>
          <span style="font-weight: 300; color: var(--text-primary); font-size: 0.9rem; letter-spacing: -0.01em">
            Auth<span style="font-weight: 600"> Service</span>
          </span>
        </RouterLink>

        <!-- Right actions -->
        <div class="flex items-center gap-1">

          <!-- Theme toggle (always visible) -->
          <button class="btn btn-ghost p-2" @click="toggleTheme" :title="t('nav.toggleTheme')">
            <Moon v-if="!isDark" class="w-4 h-4" />
            <Sun v-else class="w-4 h-4" />
          </button>

          <!-- User menu (authenticated only) -->
          <div v-if="authStore.isAuthenticated" ref="menuRef" class="relative">
            <button class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors" :style="{
              color: 'var(--text-muted)',
              background: userMenuOpen ? 'var(--bg-secondary)' : 'transparent',
            }" @click="userMenuOpen = !userMenuOpen">
              <!-- Avatar circle with user initial -->
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold" style="
                  background: linear-gradient(135deg, rgba(34,211,238,0.15), rgba(59,130,246,0.15));
                  border: 1px solid rgba(34,211,238,0.2);
                  color: var(--accent-cyan);
                ">
                {{ userInitial }}
              </div>
              <ChevronDown class="w-3.5 h-3.5 transition-transform duration-200"
                :style="{ transform: userMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }" />
            </button>

            <!-- Dropdown -->
            <div v-if="userMenuOpen" class="dropdown-menu">
              <!-- User info header -->
              <div class="px-3 py-2.5">
                <p class="text-xs font-semibold" style="color: var(--text-primary)">
                  {{ authStore.user?.name }}
                </p>
                <p class="text-xs mt-0.5 truncate" style="color: var(--text-muted); max-width: 11rem">
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
