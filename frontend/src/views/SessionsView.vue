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
    return new Date(str).toLocaleString(undefined, {
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
    if (!ua) return "Unknown browser";
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
  <div class="sessions-root">
    <div class="view-header">
      <h1 class="view-title">{{ t("profile.sessions") }}</h1>
      <button v-if="otherSessions.length > 0" class="btn btn-secondary btn-sm" :disabled="revokingAll"
        @click="revokeOtherSessions">
        <LogOut class="w-4 h-4" />
        {{ revokingAll ? t("common.loading") : t("sessions.revokeOthers") }}
      </button>
    </div>

    <p class="view-desc">{{ t("sessions.description") }}</p>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="loading" class="sessions-loading">{{ t("common.loading") }}</div>

    <div v-else-if="sessions.length === 0" class="sessions-empty">
      <p>{{ t("sessions.noSessions") }}</p>
    </div>

    <div v-else class="sessions-list">
      <div v-for="session in sessions" :key="session.id" class="session-item"
        :class="{ 'session-item--current': session.isCurrent }">
        <!-- Device icon -->
        <div class="session-icon" :class="{ 'session-icon--current': session.isCurrent }">
          <component :is="getDeviceIcon(session.userAgent)" class="w-4 h-4" />
        </div>

        <!-- Details -->
        <div class="session-details">
          <div class="session-name-row">
            <span class="session-name">{{ parseUserAgent(session.userAgent) }}</span>
            <span v-if="session.isCurrent" class="badge badge-success">{{ t("sessions.current") }}</span>
          </div>
          <div class="session-meta">
            <p v-if="session.ipAddress" class="session-meta-item font-mono">
              IP: {{ session.ipAddress }}
            </p>
            <p class="session-meta-item">
              {{ t("sessions.createdAt") }}: {{ formatDate(session.createdAt) }}
            </p>
            <p class="session-meta-item">
              {{ t("sessions.expiresAt") }}: {{ formatDate(session.expiresAt) }}
            </p>
          </div>
        </div>

        <!-- Revoke button -->
        <button v-if="!session.isCurrent" class="btn btn-ghost session-revoke-btn"
          :disabled="revoking.has(session.token)" :title="t('sessions.revoke')" @click="revokeSession(session.token)">
          <Trash2 class="w-4 h-4" style="color: var(--color-danger)" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .sessions-root {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .view-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding-bottom: 0.375rem;
  }

  .view-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .view-desc {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0 0 1.5rem;
  }

  .sessions-loading {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .sessions-empty {
    text-align: center;
    padding: 2rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .sessions-list {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .session-item {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    transition: border-color 0.15s ease;
  }

  .session-item--current {
    border-color: var(--color-primary-border);
    background: var(--color-primary-light);
  }

  .session-icon {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: var(--color-bg);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .session-icon--current {
    background: var(--color-primary-light);
    color: var(--color-primary);
    border-color: var(--color-primary-border);
  }

  .session-details {
    flex: 1;
    min-width: 0;
  }

  .session-name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .session-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .session-meta {
    margin-top: 0.375rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .session-meta-item {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .session-revoke-btn {
    padding: 0.5rem;
    flex-shrink: 0;
  }
</style>
