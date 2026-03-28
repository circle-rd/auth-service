<script setup lang="ts">
    import { computed } from "vue";
    import { useRoute, RouterLink, RouterView } from "vue-router";
    import { useI18n } from "vue-i18n";
    import { useAuthStore } from "../stores/auth.js";
    import { User, KeyRound, CreditCard, Monitor } from "lucide-vue-next";

    const { t } = useI18n();
    const authStore = useAuthStore();
    const route = useRoute();

    const tabs = [
        { path: "/profile", label: t("profile.personalInfo"), icon: User, exact: true },
        { path: "/profile/mfa", label: t("profile.mfaSettings"), icon: KeyRound, exact: false },
        { path: "/profile/subscription", label: t("profile.subscription"), icon: CreditCard, exact: false },
        { path: "/profile/sessions", label: t("profile.sessions"), icon: Monitor, exact: false },
    ];

    function isActive(tab: { path: string; exact: boolean; }): boolean {
        if (tab.exact) return route.path === tab.path;
        return route.path.startsWith(tab.path);
    }

    const userInitial = computed(() => (authStore.user?.name ?? "?").charAt(0).toUpperCase());
    const avatarUrl = computed(() => (authStore.user as Record<string, unknown>)?.image as string | undefined);
</script>

<template>
    <div class="profile-page">
        <div class="profile-container">
            <div class="profile-card">

                <!-- ── Sidebar ──────────────────────────────────────────── -->
                <aside class="profile-sidebar">
                    <!-- User identity block -->
                    <div class="sidebar-identity">
                        <div class="sidebar-avatar">
                            <img v-if="avatarUrl" :src="avatarUrl" :alt="authStore.user?.name ?? ''"
                                class="avatar-img" />
                            <span v-else class="avatar-initial">{{ userInitial }}</span>
                        </div>
                        <div class="sidebar-user-info">
                            <p class="sidebar-user-name">{{ authStore.user?.name }}</p>
                            <p class="sidebar-user-email">{{ authStore.user?.email }}</p>
                        </div>
                    </div>

                    <!-- Separator + section label -->
                    <div class="sidebar-section-head">
                        <span class="sidebar-section-label">{{ t("nav.profile") }}</span>
                    </div>

                    <!-- Nav -->
                    <nav class="sidebar-nav">
                        <RouterLink v-for="tab in tabs" :key="tab.path" :to="tab.path" :title="tab.label"
                            class="sidebar-link" :class="{ 'sidebar-link--active': isActive(tab) }">
                            <component :is="tab.icon" class="sidebar-link-icon" />
                            <span class="sidebar-link-label">{{ tab.label }}</span>
                        </RouterLink>
                    </nav>
                </aside>

                <!-- ── Content ─────────────────────────────────────────── -->
                <main class="profile-content">
                    <RouterView />
                </main>

            </div>
        </div>
    </div>
</template>

<style scoped>

    /* ── Page wrapper ───────────────────────────────────────────── */
    .profile-page {
        padding-top: 5rem;
        padding-bottom: 3rem;
        min-height: 100dvh;
        background: var(--bg-primary);
    }

    .profile-container {
        max-width: 56rem;
        margin: 0 auto;
        padding: 0 1rem;
    }

    /* ── Card shell ─────────────────────────────────────────────── */
    .profile-card {
        display: flex;
        align-items: stretch;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 1.25rem;
        overflow: hidden;
        box-shadow: var(--card-shadow);
        min-height: 36rem;
    }

    /* ── Sidebar ────────────────────────────────────────────────── */
    .profile-sidebar {
        display: flex;
        flex-direction: column;
        width: 100%;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
        padding: 1.25rem 0.5rem 1rem;
    }

    @media (min-width: 640px) {
        .profile-sidebar {
            width: 13rem;
            border-bottom: none;
            border-right: 1px solid var(--border);
            padding: 1.75rem 0.75rem 1.5rem;
        }
    }

    @media (min-width: 768px) {
        .profile-sidebar {
            width: 14rem;
        }
    }

    /* Mobile: sidebar is horizontal tabs row */
    @media (max-width: 639px) {
        .profile-card {
            flex-direction: column;
        }

        .profile-sidebar {
            flex-direction: row;
            align-items: center;
            gap: 0.25rem;
            overflow-x: auto;
            scrollbar-width: none;
            padding: 0.75rem 0.75rem;
        }

        .sidebar-identity,
        .sidebar-section-head {
            display: none;
        }

        .sidebar-nav {
            display: flex;
            flex-direction: row;
            gap: 0.25rem;
            flex: 1;
        }

        .sidebar-link {
            flex-direction: column;
            gap: 0.25rem;
            padding: 0.5rem 0.75rem;
            border-left: none;
            border-bottom: 2px solid transparent;
            border-radius: 0.5rem 0.5rem 0 0;
            font-size: 0.7rem;
            white-space: nowrap;
        }

        .sidebar-link--active {
            border-bottom-color: var(--accent-cyan) !important;
            border-left-color: transparent !important;
        }
    }

    /* ── Identity block ─────────────────────────────────────────── */
    .sidebar-identity {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0 0.25rem 1.25rem;
    }

    .sidebar-avatar {
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 9999px;
        overflow: hidden;
        flex-shrink: 0;
        background: linear-gradient(135deg, rgba(34, 211, 238, 0.12) 0%, rgba(59, 130, 246, 0.12) 100%);
        border: 1.5px solid rgba(34, 211, 238, 0.25);
        box-shadow: 0 0 12px rgba(34, 211, 238, 0.1);
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .avatar-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .avatar-initial {
        font-size: 1rem;
        font-weight: 700;
        color: var(--accent-cyan);
    }

    .sidebar-user-info {
        min-width: 0;
        flex: 1;
    }

    .sidebar-user-name {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-primary);
        truncate: ellipsis;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin: 0;
    }

    .sidebar-user-email {
        font-size: 0.7rem;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin: 0.15rem 0 0;
    }

    /* ── Section head ───────────────────────────────────────────── */
    .sidebar-section-head {
        padding: 0 0.25rem 0.5rem;
        border-top: 1px solid var(--border);
        padding-top: 1rem;
        margin-bottom: 0.25rem;
    }

    .sidebar-section-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.55rem;
        text-transform: uppercase;
        letter-spacing: 0.2em;
        color: var(--text-muted);
        opacity: 0.5;
    }

    /* ── Nav items ──────────────────────────────────────────────── */
    .sidebar-nav {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }

    .sidebar-link {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.55rem 0.75rem;
        color: var(--text-muted);
        text-decoration: none;
        border-left: 2px solid transparent;
        border-radius: 0 0.5rem 0.5rem 0;
        font-size: 0.8125rem;
        transition: color 0.15s, background 0.15s, border-color 0.15s;
        white-space: nowrap;
    }

    .sidebar-link:hover {
        color: var(--text-primary);
        background: var(--bg-secondary);
    }

    .sidebar-link--active {
        color: var(--accent-cyan);
        background: rgba(34, 211, 238, 0.06);
        border-left-color: var(--accent-cyan);
        font-weight: 500;
    }

    html:not(.dark) .sidebar-link--active {
        color: var(--accent-cyan);
        background: rgba(8, 145, 178, 0.05);
        border-left-color: var(--accent-cyan);
    }

    .sidebar-link-icon {
        width: 0.9rem;
        height: 0.9rem;
        flex-shrink: 0;
    }

    .sidebar-link-label {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* ── Content pane ───────────────────────────────────────────── */
    .profile-content {
        flex: 1;
        min-width: 0;
        padding: 2rem 1.5rem;
        overflow: hidden;
    }

    @media (min-width: 768px) {
        .profile-content {
            padding: 2.5rem 2rem;
        }
    }

    @media (max-width: 639px) {
        .profile-content {
            padding: 1.5rem 1rem;
        }
    }
</style>
