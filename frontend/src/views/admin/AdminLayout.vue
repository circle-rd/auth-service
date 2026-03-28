<script setup lang="ts">
  import { ref, computed, watch, onMounted, onUnmounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
  import {
    LayoutDashboard, Users, LayoutGrid, Shield, ChevronLeft, ChevronRight,
    Menu, X, Sun, Moon, LogOut, User, ChevronDown,
  } from "lucide-vue-next";
  import { useAuthStore } from "../../stores/auth.js";

  const { t } = useI18n();
  const route = useRoute();
  const router = useRouter();
  const authStore = useAuthStore();

  // ── Sidebar state ────────────────────────────────────────────
  const collapsed = ref(false);
  const mobileOpen = ref(false);

  const STORAGE_KEY = "admin-sidebar-collapsed";
  onMounted(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") collapsed.value = true;
  });
  watch(collapsed, (v) => localStorage.setItem(STORAGE_KEY, String(v)));

  // Close mobile sidebar on route change
  watch(() => route.path, () => { mobileOpen.value = false; });

  // ── Theme toggle ─────────────────────────────────────────────
  const isDark = ref(document.documentElement.classList.contains("dark"));
  function toggleTheme() {
    isDark.value = !isDark.value;
    document.documentElement.classList.toggle("dark", isDark.value);
    localStorage.setItem("theme", isDark.value ? "dark" : "light");
  }

  // ── User menu ─────────────────────────────────────────────────
  const userMenuOpen = ref(false);
  const userMenuRef = ref<HTMLElement | null>(null);
  function handleClickOutside(e: MouseEvent) {
    if (userMenuRef.value && !userMenuRef.value.contains(e.target as Node)) {
      userMenuOpen.value = false;
    }
  }
  onMounted(() => document.addEventListener("click", handleClickOutside));
  onUnmounted(() => document.removeEventListener("click", handleClickOutside));

  async function handleSignOut() {
    userMenuOpen.value = false;
    await authStore.signOut();
    await router.push("/login");
  }

  const userInitial = computed(() => (authStore.user?.name ?? "?").charAt(0).toUpperCase());

  // ── App sub-section ───────────────────────────────────────────
  const currentAppId = computed(() => {
    const m = route.path.match(/^\/admin\/applications\/([^/]+)/);
    return m ? m[1] : null;
  });

  const appSub = ref<{ id: string; name: string; } | null>(null);
  watch(
    currentAppId,
    async (id) => {
      if (!id) { appSub.value = null; return; }
      if (appSub.value?.id === id) return;
      try {
        const res = await fetch("/api/admin/applications", { credentials: "include" });
        const data = await res.json() as { applications: Array<{ id: string; name: string; }>; };
        const found = data.applications.find((a) => a.id === id);
        appSub.value = found ? { id: found.id, name: found.name } : null;
      } catch { appSub.value = null; }
    },
    { immediate: true },
  );

  const appSubLinks = computed(() => {
    if (!appSub.value) return [];
    const base = `/admin/applications/${appSub.value.id}`;
    return [
      { path: base, label: t("admin.appSettings"), exact: true },
      { path: `${base}/roles`, label: t("admin.roles"), exact: false },
      { path: `${base}/plans`, label: t("admin.plans"), exact: false },
      { path: `${base}/users`, label: t("admin.appUsers"), exact: false },
      { path: `${base}/usage`, label: t("admin.usage"), exact: false },
      { path: `${base}/integration`, label: t("admin.integration"), exact: false },
    ];
  });

  function isSubActive(path: string, exact: boolean) {
    if (exact) return route.path === path;
    return route.path.startsWith(path);
  }
</script>

<template>
  <div class="admin-shell">

    <!-- ── Sidebar overlay (mobile) ─────────────────────────── -->
    <Transition name="overlay">
      <div v-if="mobileOpen" class="sidebar-overlay" @click="mobileOpen = false" />
    </Transition>

    <!-- ── Sidebar ───────────────────────────────────────────── -->
    <aside class="admin-sidebar" :class="{ 'sidebar--collapsed': collapsed, 'sidebar--mobile-open': mobileOpen }">
      <!-- Logo header -->
      <div class="sidebar-header">
        <RouterLink to="/admin" class="sidebar-logo" :title="collapsed ? 'Auth Service' : ''">
          <div class="sidebar-logo-icon">
            <Shield class="w-4 h-4" style="color: var(--accent-cyan)" />
          </div>
          <Transition name="fade-label">
            <span v-if="!collapsed" class="sidebar-logo-text">
              Auth<span style="font-weight: 700">Service</span>
            </span>
          </Transition>
        </RouterLink>
        <!-- Desktop collapse toggle -->
        <button class="sidebar-collapse-btn" @click="collapsed = !collapsed" :title="collapsed ? 'Expand' : 'Collapse'">
          <ChevronLeft v-if="!collapsed" class="w-3.5 h-3.5" />
          <ChevronRight v-else class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Nav -->
      <nav class="sidebar-nav">
        <!-- Dashboard -->
        <RouterLink to="/admin/dashboard" class="nav-link"
          :class="{ 'nav-link-active': route.path === '/admin/dashboard' || route.path === '/admin' }"
          :title="collapsed ? t('admin.dashboard') : ''">
          <LayoutDashboard class="w-4 h-4 shrink-0" />
          <Transition name="fade-label">
            <span v-if="!collapsed">{{ t("admin.dashboard") }}</span>
          </Transition>
        </RouterLink>

        <!-- Users -->
        <RouterLink to="/admin/users" class="nav-link"
          :class="{ 'nav-link-active': route.path.startsWith('/admin/users') }"
          :title="collapsed ? t('admin.users') : ''">
          <Users class="w-4 h-4 shrink-0" />
          <Transition name="fade-label">
            <span v-if="!collapsed">{{ t("admin.users") }}</span>
          </Transition>
        </RouterLink>

        <!-- Applications -->
        <RouterLink to="/admin/applications" class="nav-link"
          :class="{ 'nav-link-active': route.path.startsWith('/admin/applications') }"
          :title="collapsed ? t('admin.applications') : ''">
          <LayoutGrid class="w-4 h-4 shrink-0" />
          <Transition name="fade-label">
            <span v-if="!collapsed">{{ t("admin.applications") }}</span>
          </Transition>
        </RouterLink>

        <!-- App sub-section ──────────────── -->
        <Transition name="sub-section">
          <div v-if="appSub && !collapsed" class="app-sub-section">
            <div class="app-sub-header">
              <LayoutGrid class="w-3 h-3 shrink-0 opacity-60" />
              <span class="app-sub-name">{{ appSub.name }}</span>
            </div>
            <RouterLink v-for="link in appSubLinks" :key="link.path" :to="link.path" class="nav-link nav-link--sub"
              :class="{ 'nav-link-active': isSubActive(link.path, link.exact) }">
              {{ link.label }}
            </RouterLink>
          </div>
        </Transition>
      </nav>

      <!-- Sidebar footer: profile shortcut -->
      <div class="sidebar-footer">
        <RouterLink to="/profile" class="nav-link sidebar-footer-link" :title="collapsed ? t('nav.profile') : ''">
          <div class="sidebar-user-avatar" :title="authStore.user?.name ?? ''">
            {{ userInitial }}
          </div>
          <Transition name="fade-label">
            <div v-if="!collapsed" class="sidebar-footer-info">
              <span class="text-xs font-medium truncate" style="color: var(--text-primary)">
                {{ authStore.user?.name }}
              </span>
              <span class="text-xs truncate" style="color: var(--text-muted)">
                {{ t("nav.profile") }}
              </span>
            </div>
          </Transition>
        </RouterLink>
      </div>
    </aside>

    <!-- ── Main (topbar + content) ───────────────────────────── -->
    <div class="admin-body" :class="{ 'body--collapsed': collapsed }">

      <!-- Topbar -->
      <header class="admin-topbar">
        <!-- Burger (mobile only) -->
        <button class="topbar-burger" @click="mobileOpen = !mobileOpen">
          <X v-if="mobileOpen" class="w-5 h-5" />
          <Menu v-else class="w-5 h-5" />
        </button>

        <!-- Right actions -->
        <div class="topbar-right">
          <!-- Theme toggle -->
          <button class="btn btn-ghost p-2" @click="toggleTheme" :title="t('nav.toggleTheme')">
            <Moon v-if="!isDark" class="w-4 h-4" />
            <Sun v-else class="w-4 h-4" />
          </button>

          <!-- User menu -->
          <div ref="userMenuRef" class="relative">
            <button class="topbar-user-btn" :class="{ 'topbar-user-btn--open': userMenuOpen }"
              @click="userMenuOpen = !userMenuOpen">
              <div class="topbar-avatar">{{ userInitial }}</div>
              <span class="topbar-user-name">{{ authStore.user?.name }}</span>
              <ChevronDown class="w-3.5 h-3.5 transition-transform duration-200"
                :style="{ transform: userMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }" />
            </button>

            <div v-if="userMenuOpen" class="dropdown-menu topbar-dropdown">
              <div class="px-3 py-2.5">
                <p class="text-xs font-semibold" style="color: var(--text-primary)">{{ authStore.user?.name }}</p>
                <p class="text-xs mt-0.5 truncate" style="color: var(--text-muted); max-width: 11rem">
                  {{ authStore.user?.email }}
                </p>
              </div>
              <div class="dropdown-divider" />
              <RouterLink to="/profile" class="dropdown-item" @click="userMenuOpen = false">
                <User class="w-3.5 h-3.5 shrink-0" />{{ t("nav.profile") }}
              </RouterLink>
              <div class="dropdown-divider" />
              <button class="dropdown-item dropdown-item-danger" @click="handleSignOut">
                <LogOut class="w-3.5 h-3.5 shrink-0" />{{ t("nav.signOut") }}
              </button>
            </div>
          </div>
        </div>
      </header>

      <!-- Page content -->
      <main class="admin-content">
        <RouterView />
      </main>
    </div>

  </div>
</template>

<style scoped>

  /* ── Shell ──────────────────────────────────────────────────── */
  .admin-shell {
    display: flex;
    min-height: 100dvh;
    background: var(--bg-primary);
  }

  /* ── Sidebar ────────────────────────────────────────────────── */
  .admin-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    height: 100dvh;
    width: 15rem;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-primary);
    z-index: 40;
    transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1), transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: hidden;
  }

  .sidebar--collapsed {
    width: 3.5rem;
  }

  /* Mobile: sidebar hidden by default, shown on toggle */
  @media (max-width: 767px) {
    .admin-sidebar {
      transform: translateX(-100%);
      width: 15rem;
      box-shadow: 4px 0 24px rgba(0, 0, 0, 0.25);
    }

    .sidebar--mobile-open {
      transform: translateX(0);
    }
  }

  /* ── Sidebar overlay ────────────────────────────────────────── */
  .sidebar-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 39;
    backdrop-filter: blur(2px);
  }

  /* ── Sidebar header ─────────────────────────────────────────── */
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 3.5rem;
    padding: 0 0.75rem;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    gap: 0.5rem;
    overflow: hidden;
  }

  .sidebar-logo {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    text-decoration: none;
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }

  .sidebar-logo-icon {
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    flex-shrink: 0;
    background: rgba(34, 211, 238, 0.08);
    border: 1px solid rgba(34, 211, 238, 0.15);
  }

  .sidebar-logo-text {
    font-size: 0.875rem;
    font-weight: 300;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    letter-spacing: -0.01em;
  }

  .sidebar-collapse-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .sidebar-collapse-btn:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  @media (max-width: 767px) {
    .sidebar-collapse-btn {
      display: none;
    }
  }

  /* ── Sidebar nav ────────────────────────────────────────────── */
  .sidebar-nav {
    flex: 1;
    padding: 0.75rem 0.5rem;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  /* App sub-section */
  .app-sub-section {
    margin-top: 0.125rem;
    border-left: 2px solid rgba(34, 211, 238, 0.25);
    margin-left: 0.5rem;
    padding-left: 0.5rem;
  }

  .app-sub-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.5rem 0.25rem;
  }

  .app-sub-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--accent-cyan);
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-link--sub {
    padding: 0.4rem 0.625rem;
    font-size: 0.775rem;
    border-left: none;
    border-radius: 0.375rem;
  }

  /* ── Sidebar footer ─────────────────────────────────────────── */
  .sidebar-footer {
    flex-shrink: 0;
    padding: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .sidebar-footer-link {
    padding: 0.5rem 0.5rem;
  }

  .sidebar-user-avatar {
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 9999px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.12), rgba(59, 130, 246, 0.12));
    border: 1px solid rgba(34, 211, 238, 0.2);
    color: var(--accent-cyan);
  }

  .sidebar-footer-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* ── Admin body ─────────────────────────────────────────────── */
  .admin-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 100dvh;
    margin-left: 15rem;
    transition: margin-left 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .body--collapsed {
    margin-left: 3.5rem;
  }

  @media (max-width: 767px) {
    .admin-body {
      margin-left: 0;
    }
  }

  /* ── Topbar ─────────────────────────────────────────────────── */
  .admin-topbar {
    height: 3.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
    position: sticky;
    top: 0;
    z-index: 30;
    flex-shrink: 0;
  }

  .topbar-burger {
    display: none;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .topbar-burger:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  @media (max-width: 767px) {
    .topbar-burger {
      display: flex;
    }
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }

  .topbar-user-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem 0.375rem 0.375rem;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text-muted);
    transition: background 0.15s;
  }

  .topbar-user-btn:hover,
  .topbar-user-btn--open {
    background: var(--bg-secondary);
  }

  .topbar-avatar {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    font-weight: 700;
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.15), rgba(59, 130, 246, 0.15));
    border: 1px solid rgba(34, 211, 238, 0.2);
    color: var(--accent-cyan);
    flex-shrink: 0;
  }

  .topbar-user-name {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
  }

  @media (max-width: 480px) {
    .topbar-user-name {
      display: none;
    }
  }

  .topbar-dropdown {
    right: 0;
    left: auto;
    min-width: 14rem;
  }

  /* ── Page content ───────────────────────────────────────────── */
  .admin-content {
    flex: 1;
    padding: 2rem 1.5rem;
    overflow-y: auto;
  }

  @media (min-width: 1024px) {
    .admin-content {
      padding: 2.5rem 2rem;
    }
  }

  /* ── Transitions ────────────────────────────────────────────── */
  .overlay-enter-active,
  .overlay-leave-active {
    transition: opacity 0.2s ease;
  }

  .overlay-enter-from,
  .overlay-leave-to {
    opacity: 0;
  }

  .fade-label-enter-active,
  .fade-label-leave-active {
    transition: opacity 0.15s ease;
  }

  .fade-label-enter-from,
  .fade-label-leave-to {
    opacity: 0;
  }

  .sub-section-enter-active,
  .sub-section-leave-active {
    transition: opacity 0.2s ease, max-height 0.25s ease;
    max-height: 20rem;
    overflow: hidden;
  }

  .sub-section-enter-from,
  .sub-section-leave-to {
    opacity: 0;
    max-height: 0;
  }
</style>
