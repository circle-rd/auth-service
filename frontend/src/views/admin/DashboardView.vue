<script setup lang="ts">
    import { ref, onMounted } from "vue";
    import { useI18n } from "vue-i18n";
    import { Users, LayoutGrid, Activity, ShieldCheck, Clock } from "lucide-vue-next";

    const { t } = useI18n();

    // ── KPIs ─────────────────────────────────────────────────────
    const kpis = ref({
        users: 0,
        applications: 0,
        activeSessions: 0,
        bannedUsers: 0,
    });

    const recentSessions = ref<Array<{
        id: string;
        userId: string;
        userName: string;
        userEmail: string;
        ipAddress?: string;
        userAgent?: string;
        createdAt: string;
    }>>([]);

    const loading = ref(true);

    async function loadDashboard() {
        loading.value = true;
        try {
            const [usersRes, appsRes, sessionsRes] = await Promise.all([
                fetch("/api/admin/users?page=1&limit=1", { credentials: "include" }),
                fetch("/api/admin/applications", { credentials: "include" }),
                fetch("/api/admin/sessions?limit=10", { credentials: "include" }),
            ]);

            if (usersRes.ok) {
                const data = await usersRes.json() as { users: Array<{ banned?: boolean; }>; total: number; };
                kpis.value.users = data.total;
                kpis.value.bannedUsers = data.users.filter((u) => u.banned).length;
            }

            if (appsRes.ok) {
                const data = await appsRes.json() as { applications: unknown[]; };
                kpis.value.applications = data.applications.length;
            }

            if (sessionsRes.ok) {
                const data = await sessionsRes.json() as {
                    sessions?: Array<{
                        id: string;
                        userId: string;
                        userName?: string;
                        userEmail?: string;
                        ipAddress?: string;
                        userAgent?: string;
                        createdAt: string;
                    }>;
                    total?: number;
                };
                recentSessions.value = (data.sessions ?? []).map((s) => ({
                    id: s.id,
                    userId: s.userId,
                    userName: s.userName ?? "—",
                    userEmail: s.userEmail ?? "",
                    ipAddress: s.ipAddress,
                    userAgent: s.userAgent,
                    createdAt: s.createdAt,
                }));
                kpis.value.activeSessions = data.total ?? recentSessions.value.length;
            }
        } finally {
            loading.value = false;
        }
    }

    function formatDate(d: string) {
        const date = new Date(d);
        return date.toLocaleString(undefined, {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
        });
    }

    function parseUA(ua?: string): string {
        if (!ua) return "—";
        if (ua.includes("Firefox")) return "Firefox";
        if (ua.includes("Edg")) return "Edge";
        if (ua.includes("Chrome")) return "Chrome";
        if (ua.includes("Safari")) return "Safari";
        if (ua.includes("curl")) return "curl";
        return ua.slice(0, 24);
    }

    onMounted(loadDashboard);
</script>

<template>
    <div class="space-y-6">
        <!-- Page header -->
        <div>
            <h1 class="text-2xl font-bold gradient-text">{{ t("admin.dashboard") }}</h1>
            <p class="text-sm mt-1" style="color: var(--color-text-muted)">Overview of the authentication service</p>
        </div>

        <!-- KPI cards -->
        <div class="kpi-grid">
            <div class="kpi-card">
                <div class="kpi-icon kpi-icon--blue">
                    <Users class="w-5 h-5" />
                </div>
                <div class="kpi-body">
                    <p class="kpi-label">{{ t("admin.users") }}</p>
                    <p class="kpi-value">
                        <span v-if="loading" class="kpi-loading" />
                        <span v-else>{{ kpis.users.toLocaleString() }}</span>
                    </p>
                </div>
            </div>

            <div class="kpi-card">
                <div class="kpi-icon kpi-icon--primary">
                    <LayoutGrid class="w-5 h-5" />
                </div>
                <div class="kpi-body">
                    <p class="kpi-label">{{ t("admin.applications") }}</p>
                    <p class="kpi-value">
                        <span v-if="loading" class="kpi-loading" />
                        <span v-else>{{ kpis.applications.toLocaleString() }}</span>
                    </p>
                </div>
            </div>

            <div class="kpi-card">
                <div class="kpi-icon kpi-icon--green">
                    <Activity class="w-5 h-5" />
                </div>
                <div class="kpi-body">
                    <p class="kpi-label">Active sessions</p>
                    <p class="kpi-value">
                        <span v-if="loading" class="kpi-loading" />
                        <span v-else>{{ kpis.activeSessions.toLocaleString() }}</span>
                    </p>
                </div>
            </div>

            <div class="kpi-card">
                <div class="kpi-icon kpi-icon--red">
                    <ShieldCheck class="w-5 h-5" />
                </div>
                <div class="kpi-body">
                    <p class="kpi-label">Banned users</p>
                    <p class="kpi-value">
                        <span v-if="loading" class="kpi-loading" />
                        <span v-else>{{ kpis.bannedUsers.toLocaleString() }}</span>
                    </p>
                </div>
            </div>
        </div>

        <!-- Recent sessions -->
        <div class="card !p-0 overflow-hidden">
            <div class="flex items-center justify-between px-5 py-4"
                style="border-bottom: 1px solid var(--color-border)">
                <div class="flex items-center gap-2">
                    <Clock class="w-4 h-4" style="color: var(--color-primary)" />
                    <h2 class="text-sm font-semibold">Recent sessions</h2>
                </div>
                <span class="text-xs" style="color: var(--color-text-muted)">Last 10</span>
            </div>

            <div v-if="loading" class="px-5 py-10 text-center text-sm" style="color: var(--color-text-muted)">
                {{ t("common.loading") }}
            </div>

            <div v-else-if="recentSessions.length === 0" class="px-5 py-10 text-center text-sm"
                style="color: var(--color-text-muted)">
                No sessions available
            </div>

            <div v-else class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr style="border-bottom: 1px solid var(--color-border)">
                            <th class="text-left px-5 py-3 text-xs font-medium uppercase tracking-wide"
                                style="color: var(--color-text-muted)">User</th>
                            <th class="text-left px-5 py-3 text-xs font-medium uppercase tracking-wide hidden sm:table-cell"
                                style="color: var(--color-text-muted)">IP</th>
                            <th class="text-left px-5 py-3 text-xs font-medium uppercase tracking-wide hidden md:table-cell"
                                style="color: var(--color-text-muted)">Browser</th>
                            <th class="text-left px-5 py-3 text-xs font-medium uppercase tracking-wide"
                                style="color: var(--color-text-muted)">Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="s in recentSessions" :key="s.id" class="transition-colors"
                            style="border-bottom: 1px solid var(--color-border)"
                            :style="{ '--hover-bg': 'var(--color-bg)' }">
                            <td class="px-5 py-3">
                                <div class="flex items-center gap-2.5">
                                    <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                                        style="background: var(--color-primary-light); color: var(--color-primary)">
                                        {{ (s.userName?.[0] ?? "?").toUpperCase() }}
                                    </div>
                                    <div>
                                        <p class="font-medium text-sm leading-tight">{{ s.userName }}</p>
                                        <p class="text-xs" style="color: var(--color-text-muted)">{{ s.userEmail }}</p>
                                    </div>
                                </div>
                            </td>
                            <td class="px-5 py-3 hidden sm:table-cell">
                                <code class="text-xs font-mono" style="color: var(--color-text-muted)">
                  {{ s.ipAddress ?? "—" }}
                </code>
                            </td>
                            <td class="px-5 py-3 hidden md:table-cell text-xs" style="color: var(--color-text-muted)">
                                {{ parseUA(s.userAgent) }}
                            </td>
                            <td class="px-5 py-3 text-xs" style="color: var(--color-text-muted)">
                                {{ formatDate(s.createdAt) }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</template>

<style scoped>
    .kpi-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1rem;
    }

    @media (min-width: 768px) {
        .kpi-grid {
            grid-template-columns: repeat(4, 1fr);
        }
    }

    .kpi-card {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        padding: 1.25rem;
        display: flex;
        align-items: center;
        gap: 1rem;
        transition: border-color 0.2s, box-shadow 0.2s;
        box-shadow: var(--shadow-sm);
    }

    .kpi-card:hover {
        border-color: var(--color-border-hover);
    }

    .kpi-icon {
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .kpi-icon--blue {
        background: rgba(59, 130, 246, 0.1);
        border: 1px solid rgba(59, 130, 246, 0.15);
        color: #60a5fa;
    }

    .kpi-icon--primary {
        background: var(--color-primary-light);
        border: 1px solid var(--color-primary-border);
        color: var(--color-primary);
    }

    .kpi-icon--green {
        background: rgba(16, 185, 129, 0.1);
        border: 1px solid rgba(16, 185, 129, 0.15);
        color: #34d399;
    }

    .kpi-icon--red {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.15);
        color: #f87171;
    }

    .kpi-body {
        min-width: 0;
    }

    .kpi-label {
        font-size: 0.7rem;
        font-family: 'JetBrains Mono', monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--color-text-muted);
        margin: 0 0 0.25rem;
    }

    .kpi-value {
        font-size: 1.625rem;
        font-weight: 700;
        color: var(--color-text);
        margin: 0;
        line-height: 1;
    }

    .kpi-loading {
        display: inline-block;
        width: 2rem;
        height: 1.5rem;
        background: var(--color-border);
        border-radius: 0.25rem;
        animation: pulse 1.5s ease-in-out infinite;
    }

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
