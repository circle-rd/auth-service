<script setup lang="ts">
  import { ref, onMounted } from "vue";
  import { useRoute } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { ShieldCheck, X } from "lucide-vue-next";

  const { t } = useI18n();
  const route = useRoute();

  interface ClientInfo {
    client_name?: string;
    name?: string;
  }

  const clientName = ref<string>("");
  const scopes = ref<string[]>([]);
  const loading = ref(true);
  const submitting = ref(false);
  const error = ref<string | null>(null);

  // The full signed query string from the URL — required by /oauth2/consent
  const oauthQuery = ref<string>("");

  onMounted(async () => {
    // Capture the entire query string (signed by BetterAuth, must be forwarded as-is)
    const search = window.location.search;
    oauthQuery.value = search.startsWith("?") ? search.substring(1) : search;

    const clientId = route.query.client_id as string | undefined;
    const scopeParam = (route.query.scope as string | undefined) ?? "";
    scopes.value = scopeParam.split(" ").filter(Boolean);

    // Fetch public client info to display the app name
    if (clientId) {
      try {
        const res = await fetch(
          `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = (await res.json()) as ClientInfo;
          clientName.value = data.client_name ?? data.name ?? clientId;
        } else {
          clientName.value = clientId;
        }
      } catch {
        clientName.value = clientId;
      }
    }

    loading.value = false;
  });

  async function respond(accept: boolean) {
    submitting.value = true;
    error.value = null;
    try {
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ accept, oauth_query: oauthQuery.value }),
      });
      const data = (await res.json()) as { redirect?: boolean; url?: string; };
      if (data.redirect && data.url) {
        window.location.href = data.url;
      }
    } catch {
      error.value = t("errors.SRV_001");
    } finally {
      submitting.value = false;
    }
  }
</script>

<template>
  <div class="consent-page">
    <div class="consent-container">

      <!-- Header -->
      <div class="consent-header">
        <div class="consent-icon">
          <ShieldCheck class="w-6 h-6" />
        </div>
        <h1 class="consent-title">{{ t("consent.title") }}</h1>
        <p v-if="!loading" class="consent-subtitle">
          {{ t("consent.requestingAccess", { app: clientName }) }}
        </p>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="card consent-card text-center" style="color: var(--color-text-muted)">
        {{ t("common.loading") }}
      </div>

      <!-- Content -->
      <div v-else class="card consent-card">
        <!-- Requested scopes -->
        <div class="scopes-section">
          <p class="scopes-title">{{ t("consent.scopes") }}</p>
          <ul class="scopes-list">
            <li v-for="scope in scopes" :key="scope" class="scope-item">
              <ShieldCheck class="w-4 h-4 shrink-0" style="color: var(--color-primary)" />
              <span>{{ t(`consent.scope.${scope}`, scope) }}</span>
            </li>
          </ul>
        </div>

        <p v-if="error" class="consent-error">{{ error }}</p>

        <!-- Actions -->
        <div class="consent-actions">
          <button class="btn btn-primary flex-1" :disabled="submitting" @click="respond(true)">
            {{ submitting ? t("common.loading") : t("consent.allow") }}
          </button>
          <button class="btn btn-secondary flex-1" :disabled="submitting" @click="respond(false)">
            <X class="w-4 h-4" />
            {{ t("consent.deny") }}
          </button>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
  .consent-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 5rem 1rem 2rem;
    background: var(--color-bg);
  }

  .consent-container {
    width: 100%;
    max-width: 24rem;
  }

  .consent-header {
    margin-bottom: 2rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .consent-icon {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
  }

  .consent-title {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .consent-subtitle {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .consent-card {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .scopes-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .scopes-title {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
    margin: 0;
  }

  .scopes-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .scope-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-text);
  }

  .consent-error {
    font-size: 0.875rem;
    color: var(--color-danger);
    margin: 0;
  }

  .consent-actions {
    display: flex;
    gap: 0.75rem;
  }
</style>
