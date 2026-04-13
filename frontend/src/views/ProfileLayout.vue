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
    const userCompany = computed(() => (authStore.user as Record<string, unknown>)?.company as string | undefined);
    const userPosition = computed(() => (authStore.user as Record<string, unknown>)?.position as string | undefined);
</script>

<template>
    <div class="profile-root">

        <!-- ── Hero band ──────────────────────────────────────────────── -->
        <div class="profile-hero">
            <div class="hero-inner">
                <div class="hero-avatar">
                    <img v-if="avatarUrl" :src="avatarUrl" :alt="authStore.user?.name ?? ''" class="hero-avatar-img" />
                    <span v-else class="hero-avatar-initial">{{ userInitial }}</span>
                </div>
                <div class="hero-identity">
                    <p class="hero-name">{{ authStore.user?.name }}</p>
                    <p v-if="userPosition || userCompany" class="hero-meta">
                        <span v-if="userPosition">{{ userPosition }}</span>
                        <span v-if="userPosition && userCompany" class="hero-meta-sep">·</span>
                        <span v-if="userCompany">{{ userCompany }}</span>
                    </p>
                    <p class="hero-email">{{ authStore.user?.email }}</p>
                </div>
            </div>
        </div>

        <!-- ── Sticky tab bar ─────────────────────────────────────────── -->
        <div class="profile-tabs">
            <div class="profile-tabs-inner">
                <RouterLink
                    v-for="tab in tabs"
                    :key="tab.path"
                    :to="tab.path"
                    class="profile-tab-link"
                    :class="{ 'profile-tab-link--active': isActive(tab) }"
                >
                    <component :is="tab.icon" class="tab-icon" />
                    <span>{{ tab.label }}</span>
                </RouterLink>
            </div>
        </div>

        <!-- ── Content ───────────────────────────────────────────────── -->
        <main class="profile-body">
            <RouterView />
        </main>

    </div>
</template>

<style scoped>

    /* ── Root ───────────────────────────────────────────────────── */
    .profile-root {
        min-height: 100dvh;
        background: var(--color-bg);
    }

    /* ── Hero ───────────────────────────────────────────────────── */
    .profile-hero {
        background: var(--color-hero-bg);
        padding-top: 4.5rem; /* clear fixed nav */
        border-bottom: 1px solid var(--color-border);
    }

    .hero-inner {
        max-width: var(--profile-max-w);
        margin: 0 auto;
        padding: 2rem 1.5rem 1.75rem;
        display: flex;
        align-items: center;
        gap: 1.25rem;
    }

    @media (max-width: 639px) {
        .hero-inner {
            padding: 1.5rem 1rem 1.25rem;
            gap: 0.875rem;
        }
    }

    /* ── Avatar ─────────────────────────────────────────────────── */
    .hero-avatar {
        width: 4.5rem;
        height: 4.5rem;
        border-radius: 50%;
        flex-shrink: 0;
        overflow: hidden;
        background: var(--color-primary-light);
        border: 2px solid var(--color-primary-border);
        box-shadow: 0 0 0 3px var(--color-primary), 0 0 0 5px var(--color-hero-bg);
        display: flex;
        align-items: center;
        justify-content: center;
    }

    @media (max-width: 639px) {
        .hero-avatar {
            width: 3.25rem;
            height: 3.25rem;
            box-shadow: 0 0 0 2px var(--color-primary), 0 0 0 4px var(--color-hero-bg);
        }
    }

    .hero-avatar-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .hero-avatar-initial {
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--color-primary);
    }

    @media (max-width: 639px) {
        .hero-avatar-initial {
            font-size: 1.125rem;
        }
    }

    /* ── Identity ───────────────────────────────────────────────── */
    .hero-identity {
        min-width: 0;
        flex: 1;
    }

    .hero-name {
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--color-text);
        margin: 0;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    @media (max-width: 639px) {
        .hero-name {
            font-size: 1rem;
        }
    }

    .hero-meta {
        font-size: 0.8125rem;
        color: var(--color-text-muted);
        margin: 0.25rem 0 0;
        display: flex;
        align-items: center;
        gap: 0.375rem;
        flex-wrap: wrap;
    }

    .hero-meta-sep {
        opacity: 0.45;
    }

    .hero-email {
        font-size: 0.8125rem;
        color: var(--color-text-light);
        margin: 0.2rem 0 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    @media (max-width: 639px) {
        .hero-email {
            display: none;
        }
    }

    /* ── Tab bar ────────────────────────────────────────────────── */
    .profile-tabs {
        position: sticky;
        top: 3.5rem;
        z-index: 10;
        background: var(--color-bg);
        border-bottom: 1px solid var(--color-border);
    }

    .profile-tabs-inner {
        max-width: var(--profile-max-w);
        margin: 0 auto;
        padding: 0 1.5rem;
        display: flex;
        gap: 0;
        overflow-x: auto;
        scrollbar-width: none;
    }

    .profile-tabs-inner::-webkit-scrollbar {
        display: none;
    }

    @media (max-width: 639px) {
        .profile-tabs-inner {
            padding: 0 1rem;
        }
    }

    .profile-tab-link {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        padding: 0.8125rem 1rem;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--color-text-muted);
        text-decoration: none;
        border-bottom: 2px solid transparent;
        white-space: nowrap;
        transition: color 0.15s, border-color 0.15s;
        flex-shrink: 0;
    }

    .profile-tab-link:hover {
        color: var(--color-text);
    }

    .profile-tab-link--active {
        color: var(--color-primary);
        border-bottom-color: var(--color-primary);
    }

    .tab-icon {
        width: 0.875rem;
        height: 0.875rem;
        flex-shrink: 0;
    }

    @media (max-width: 479px) {
        .tab-icon {
            display: none;
        }
        .profile-tab-link {
            padding: 0.75rem 0.75rem;
            font-size: 0.75rem;
        }
    }

    /* ── Body ───────────────────────────────────────────────────── */
    .profile-body {
        max-width: var(--profile-max-w);
        margin: 0 auto;
        padding: 2.5rem 1.5rem 5rem;
    }

    @media (max-width: 639px) {
        .profile-body {
            padding: 1.5rem 1rem 4rem;
        }
    }
</style>

