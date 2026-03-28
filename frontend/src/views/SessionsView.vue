<script setup lang="ts">
  import { ref, onMounted, computed } from "vue";
  import { useI18n } from "vue-i18n";
  import { Monitor, Smartphone, Globe, Trash2, LogOut } from "lucide-vue-next";

  const { t } = useI18n();

  interface SessionEntry {
    id: string;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: string;
    expiresAt: string;
    isCurrent?: boolean;
  }

  const sessions = ref<SessionEntry[]>([]);
  const loading = ref(false);
  const error = ref("");
  const revoking = ref<Set<string>>(new Set());
  const revokingAll = ref(false);

  async function fetchSessions(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const res = await fetch("/api/auth/list-sessions", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const data = (await res.json()) as SessionEntry[];
      sessions.value = data;
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t("errors.SRV_001");
    } finally {
      loading.value = false;
    }
  }

  async function revokeSession(token: string): Promise<void> {
    revoking.value = new Set([...revoking.value, token]);
    try {
      await fetch("/api/auth/revoke-session", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      await fetchSessions();
    } finally {
      revoking.value = new Set([...revoking.value].filter((t) => t !== token));
    }
  }

  async function revokeOtherSessions(): Promise<void> {
    revokingAll.value = true;
    try {
      await fetch("/api/auth/revoke-other-sessions", {
        method: "POST",
        credentials: "include",
      });
      await fetchSessions();
    } finally {
      revokingAll.value = false;
    }
  }

  function formatDate(str: string): string {
    return new Date(str).toLocaleString("fr-FR", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getDeviceIcon(ua?: string | null): typeof Monitor {
    if (!ua) return Globe;
    const lower = ua.toLowerCase();
    if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone")) return Smartphone;
    return Monitor;
  }

  function parseUserAgent(ua?: string | null): string {
    if (!ua) return "Navigateur inconnu";
    // Extract browser name
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Edg/")) return "Edge";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Safari")) return "Safari";
    if (ua.includes("curl")) return "cURL";
    return ua.slice(0, 40);
  }

  const otherSessions = computed(() => sessions.value.filter((s) => !s.isCurrent));

  onMounted(fetchSessions);
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <h1 class="text-2xl font-bold gradient-text">{{ t("profile.sessions") }}</h1>
      <button v-if="otherSessions.length > 0" class="btn btn-secondary text-sm" :disabled="revokingAll"
        @click="revokeOtherSessions">
        <LogOut class="w-4 h-4" />
        {{ revokingAll ? t("common.loading") : "Révoquer les autres" }}
      </button>
    </div>

    <p class="text-sm" style="color: var(--text-muted)">
      Liste de toutes les sessions actives associées à votre compte.
    </p>

    <div v-if="error" class="card" style="border-color: rgba(239,68,68,0.3)">
      <p class="text-sm" style="color: #f87171">{{ error }}</p>
    </div>

    <div v-if="loading" class="text-center py-8" style="color: var(--text-muted)">
      {{ t("common.loading") }}
    </div>

    <div v-else-if="sessions.length === 0" class="card text-center py-8">
      <p class="text-sm" style="color: var(--text-muted)">Aucune session active.</p>
    </div>

    <div v-else class="space-y-3">
      <div v-for="session in sessions" :key="session.id" class="card flex items-start gap-4"
        :style="session.isCurrent ? 'border-color: rgba(34,211,238,0.25)' : ''">
        <!-- Device icon -->
        <div class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5" :style="session.isCurrent
          ? 'background: rgba(34,211,238,0.1); color: var(--accent-cyan)'
          : 'background: var(--bg-secondary); color: var(--text-muted)'">
          <component :is="getDeviceIcon(session.userAgent)" class="w-4 h-4" />
        </div>

        <!-- Details -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium">{{ parseUserAgent(session.userAgent) }}</span>
            <span v-if="session.isCurrent" class="badge badge-success text-xs">Session courante</span>
          </div>
          <div class="mt-1 space-y-0.5">
            <p v-if="session.ipAddress" class="text-xs font-mono" style="color: var(--text-muted)">
              IP: {{ session.ipAddress }}
            </p>
            <p class="text-xs" style="color: var(--text-muted)">
              Créée le {{ formatDate(session.createdAt) }}
            </p>
            <p class="text-xs" style="color: var(--text-muted)">
              Expire le {{ formatDate(session.expiresAt) }}
            </p>
          </div>
        </div>

        <!-- Revoke button -->
        <button v-if="!session.isCurrent" class="btn btn-ghost p-2 shrink-0" :disabled="revoking.has(session.token)"
          :title="'Révoquer cette session'" @click="revokeSession(session.token)">
          <Trash2 class="w-4 h-4" style="color: #f87171" />
        </button>
      </div>
    </div>
  </div>
</template>
