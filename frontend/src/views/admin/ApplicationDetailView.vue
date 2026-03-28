<script setup lang="ts">
    import { ref, onMounted, computed } from "vue";
    import { useI18n } from "vue-i18n";
    import { useRoute, RouterLink } from "vue-router";
    import { ArrowLeft, Settings, Users, CreditCard, BarChart3, ShieldCheck, Puzzle } from "lucide-vue-next";
    import AppAuthConfigModal from "../../components/admin/AppAuthConfigModal.vue";

    const { t } = useI18n();
    const route = useRoute();

    const appId = computed(() => route.params.id as string);

    interface Application {
        id: string;
        name: string;
        slug: string;
        icon?: string | null;
        isActive: boolean;
        appUrl?: string | null;
        description?: string | null;
        createdAt: string;
    }

    const app = ref<Application | null>(null);
    const loading = ref(true);
    const showEditModal = ref(false);
    const userCount = ref<number | null>(null);

    async function fetchApp() {
        loading.value = true;
        try {
            const res = await fetch("/api/admin/applications", { credentials: "include" });
            const data = await res.json() as { applications: Application[]; };
            app.value = data.applications.find((a) => a.id === appId.value) ?? null;
        } finally {
            loading.value = false;
        }
    }

    async function fetchUserCount() {
        try {
            const res = await fetch(`/api/admin/applications/${appId.value}/users`, { credentials: "include" });
            if (res.ok) {
                const data = await res.json() as { users: unknown[]; };
                userCount.value = data.users.length;
            }
        } catch { /* silent */ }
    }

    function initials(name: string) {
        return name.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2);
    }

    onMounted(fetchApp);
    onMounted(fetchUserCount);
</script>

<template>
    <div class="space-y-6">
        <!-- Back + header -->
        <div class="flex items-start gap-4">
            <RouterLink to="/admin/applications" class="btn btn-ghost p-2 mt-0.5 shrink-0" :title="t('common.back')">
                <ArrowLeft class="w-4 h-4" />
            </RouterLink>
            <div v-if="loading" class="flex-1">
                <div
                    style="height: 1.5rem; width: 10rem; background: var(--border); border-radius: 0.375rem; animation: pulse 1.5s ease-in-out infinite" />
            </div>
            <div v-else-if="app" class="flex items-center gap-4 flex-1 min-w-0">
                <div>
                    <img v-if="app.icon" :src="app.icon" :alt="app.name" class="w-10 h-10 rounded-xl object-cover" />
                    <div v-else
                        class="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold font-mono"
                        style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
                        {{ initials(app.name) }}
                    </div>
                </div>
                <div class="min-w-0">
                    <h1 class="text-xl font-bold gradient-text leading-tight">{{ app.name }}</h1>
                    <div class="flex items-center gap-2 mt-0.5">
                        <code class="text-xs font-mono" style="color: var(--text-muted)">{{ app.slug }}</code>
                        <span class="badge" :class="app.isActive ? 'badge-success' : 'badge-inactive'">
                            {{ app.isActive ? t("common.active") : t("common.inactive") }}
                        </span>
                    </div>
                </div>
                <button class="btn btn-secondary text-sm ml-auto" @click="showEditModal = true">
                    <Settings class="w-4 h-4" />
                    {{ t("common.edit") }}
                </button>
            </div>
            <div v-else class="text-sm" style="color: var(--text-muted)">Application introuvable</div>
        </div>

        <!-- Quick info card -->
        <div v-if="app" class="card">
            <div class="grid gap-5" style="grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr))">
                <div v-if="app.appUrl">
                    <p class="text-xs font-medium mb-1" style="color: var(--text-muted)">URL de l'application</p>
                    <a :href="app.appUrl" target="_blank" rel="noopener noreferrer" class="text-sm truncate block"
                        style="color: var(--accent-cyan)">
                        {{ app.appUrl }}
                    </a>
                </div>
                <div v-if="app.description">
                    <p class="text-xs font-medium mb-1" style="color: var(--text-muted)">Description</p>
                    <p class="text-sm" style="color: var(--text-primary)">{{ app.description }}</p>
                </div>
                <div>
                    <p class="text-xs font-medium mb-1" style="color: var(--text-muted)">Créée le</p>
                    <p class="text-sm" style="color: var(--text-primary)">
                        {{ new Date(app.createdAt).toLocaleDateString() }}
                    </p>
                </div>
            </div>
        </div>

        <!-- KPI strip -->
        <div v-if="app" class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr))">
            <div class="card !p-4">
                <p class="text-xs font-medium mb-1" style="color: var(--text-muted)">Utilisateurs</p>
                <p class="text-lg font-bold" style="color: var(--text-primary)">
                    {{ userCount !== null ? userCount : '—' }}
                </p>
            </div>
            <div class="card !p-4">
                <p class="text-xs font-medium mb-1" style="color: var(--text-muted)">Créée le</p>
                <p class="text-sm font-medium" style="color: var(--text-primary)">
                    {{ new Date(app.createdAt).toLocaleDateString('fr-FR', {
                        year: 'numeric', month: 'short', day:
                    'numeric' }) }}
                </p>
            </div>
            <div class="card !p-4">
                <p class="text-xs font-medium mb-1" style="color: var(--text-muted)">Client ID</p>
                <p class="text-sm font-mono truncate" style="color: var(--accent-cyan)">{{ app.slug }}</p>
            </div>
        </div>

        <!-- Sub-section nav cards -->
        <div v-if="app" class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr))">
            <RouterLink :to="`/admin/applications/${appId}/roles`"
                class="card flex items-center gap-3 !p-4 hover:border-[color:var(--accent-cyan)] transition-colors"
                style="border-color: var(--border)">
                <ShieldCheck class="w-5 h-5 shrink-0" style="color: var(--accent-cyan)" />
                <div>
                    <p class="text-sm font-medium">{{ t("admin.roles") }}</p>
                    <p class="text-xs mt-0.5" style="color: var(--text-muted)">Rôles &amp; permissions</p>
                </div>
            </RouterLink>
            <RouterLink :to="`/admin/applications/${appId}/plans`"
                class="card flex items-center gap-3 !p-4 hover:border-[color:var(--accent-cyan)] transition-colors"
                style="border-color: var(--border)">
                <CreditCard class="w-5 h-5 shrink-0" style="color: var(--accent-cyan)" />
                <div>
                    <p class="text-sm font-medium">{{ t("admin.plans") }}</p>
                    <p class="text-xs mt-0.5" style="color: var(--text-muted)">Abonnements</p>
                </div>
            </RouterLink>
            <RouterLink :to="`/admin/applications/${appId}/users`"
                class="card flex items-center gap-3 !p-4 hover:border-[color:var(--accent-cyan)] transition-colors"
                style="border-color: var(--border)">
                <Users class="w-5 h-5 shrink-0" style="color: var(--accent-cyan)" />
                <div>
                    <p class="text-sm font-medium">{{ t("admin.appUsers") }}</p>
                    <p class="text-xs mt-0.5" style="color: var(--text-muted)">Accès utilisateurs</p>
                </div>
            </RouterLink>
            <RouterLink :to="`/admin/applications/${appId}/usage`"
                class="card flex items-center gap-3 !p-4 hover:border-[color:var(--accent-cyan)] transition-colors"
                style="border-color: var(--border)">
                <BarChart3 class="w-5 h-5 shrink-0" style="color: var(--accent-cyan)" />
                <div>
                    <p class="text-sm font-medium">{{ t("admin.usage") }}</p>
                    <p class="text-xs mt-0.5" style="color: var(--text-muted)">Consommation API</p>
                </div>
            </RouterLink>
            <RouterLink :to="`/admin/applications/${appId}/integration`"
                class="card flex items-center gap-3 !p-4 hover:border-[color:var(--accent-cyan)] transition-colors"
                style="border-color: var(--border)">
                <Puzzle class="w-5 h-5 shrink-0" style="color: var(--accent-cyan)" />
                <div>
                    <p class="text-sm font-medium">{{ t("admin.integration") }}</p>
                    <p class="text-xs mt-0.5" style="color: var(--text-muted)">Exemples OAuth</p>
                </div>
            </RouterLink>
        </div>

        <!-- Edit modal -->
        <AppAuthConfigModal v-if="showEditModal && app" :app-id="app.id" :open="showEditModal"
            @close="showEditModal = false" @updated="fetchApp" />
    </div>
</template>

<style scoped>
    @keyframes pulse {

        0%,
        100% {
            opacity: 1;
        }

        50% {
            opacity: 0.4;
        }
    }
</style>
