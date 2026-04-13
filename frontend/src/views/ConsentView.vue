<script setup lang="ts">
  import { ref, onMounted } from "vue";
  import { useRoute } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { ShieldCheck, X, Lock } from "lucide-vue-next";

  const { t } = useI18n();
  const route = useRoute();

  interface ClientInfo {
    client_name?: string;
    name?: string;
    logo_uri?: string;
    icon_uri?: string;
    description?: string;
  }

  const clientName = ref<string>("");
  const clientLogo = ref<string>("");
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

    // Fetch public client info to display the app name and logo
    if (clientId) {
      try {
        const res = await fetch(
          `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = (await res.json()) as ClientInfo;
          clientName.value = data.client_name ?? data.name ?? clientId;
          clientLogo.value = data.logo_uri ?? data.icon_uri ?? "";
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

  function appInitials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("");
  }
</script>

<template>
  <div class="consent-page">
    <div class="consent-wrapper">

      <!-- Title -->
      <div class="consent-title-row">
        <Lock class="w-4 h-4" style="color: var(--color-primary)" />
        <span>{{ t("consent.title") }}</span>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="consent-loading">
        <div class="card consent-card-loading">{{ t("common.loading") }}</div>
      </div>

      <!-- Main layout -->
      <div v-else class="consent-layout">

        <!-- ─── Left: Auth entity ───────────────── -->
        <div class="entity-block entity-auth">
          <div class="entity-icon entity-icon--auth">
            <ShieldCheck class="w-5 h-5" />
          </div>
          <p class="entity-name">Auth Service</p>
          <p class="entity-role">{{ t("consent.authEntityRole") }}</p>
        </div>

        <!-- ─── Center: Scope flow ─────────────── -->
        <div class="flow-center">
          <!-- Arrow left -->
          <div class="flow-arrow flow-arrow--left" aria-hidden="true">
            <svg viewBox="0 0 40 200" preserveAspectRatio="none" fill="none">
              <path d="M 38 1 C 20 1 2 20 2 100 C 2 180 20 199 38 199"
                stroke="var(--color-primary)" stroke-width="1.5" stroke-dasharray="4 3"
                stroke-linecap="round" opacity="0.45" />
              <path d="M 8 94 L 2 100 L 8 106" stroke="var(--color-primary)"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65" />
            </svg>
          </div>

          <!-- Scope list -->
          <div class="scopes-list">
            <p class="scopes-heading">{{ t("consent.scopes") }}</p>
            <ul class="scopes-items">
              <li v-for="scope in scopes" :key="scope" class="scope-row">
                <span class="scope-dot" aria-hidden="true"></span>
                <span class="scope-text">{{ t(`consent.scope.${scope}`, scope) }}</span>
              </li>
            </ul>
          </div>

          <!-- Arrow right -->
          <div class="flow-arrow flow-arrow--right" aria-hidden="true">
            <svg viewBox="0 0 40 200" preserveAspectRatio="none" fill="none">
              <path d="M 2 1 C 20 1 38 20 38 100 C 38 180 20 199 2 199"
                stroke="var(--color-primary)" stroke-width="1.5" stroke-dasharray="4 3"
                stroke-linecap="round" opacity="0.45" />
              <path d="M 32 94 L 38 100 L 32 106" stroke="var(--color-primary)"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65" />
            </svg>
          </div>
        </div>

        <!-- ─── Right: App entity ──────────────── -->
        <div class="entity-block entity-app">
          <div class="entity-icon entity-icon--app">
            <img v-if="clientLogo" :src="clientLogo" :alt="clientName" class="entity-logo-img" />
            <span v-else class="entity-initials">{{ appInitials(clientName) }}</span>
          </div>
          <p class="entity-name">{{ clientName }}</p>
          <p class="entity-role">{{ t("consent.appEntityRole") }}</p>
        </div>

      </div>

      <!-- Error -->
      <p v-if="error" class="consent-error">{{ error }}</p>

      <!-- Actions -->
      <div class="consent-actions">
        <button class="btn btn-primary" :disabled="submitting" @click="respond(true)">
          {{ submitting ? t("common.loading") : t("consent.allow") }}
        </button>
        <button class="btn btn-secondary" :disabled="submitting" @click="respond(false)">
          <X class="w-4 h-4" />
          {{ t("consent.deny") }}
        </button>
      </div>

      <p class="consent-legal">{{ t("consent.legal") }}</p>

    </div>
  </div>
</template>

<style scoped>
  /* ── Page ────────────────────────────────────────────────── */

  .consent-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 5rem 1rem 2rem;
    background: var(--color-bg);
  }

  .consent-wrapper {
    width: 100%;
    max-width: 42rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    padding: 2rem 2rem 1.5rem;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* ── Title row ───────────────────────────────────────────── */

  .consent-title-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-primary);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* ── Flow layout ─────────────────────────────────────────── */

  .consent-layout {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0;
  }

  /* ── Entity blocks ───────────────────────────────────────── */

  .entity-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.25rem 0.75rem;
  }

  .entity-icon {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    overflow: hidden;
    flex-shrink: 0;
  }

  .entity-icon--auth {
    background: var(--color-primary-light);
    border-color: var(--color-primary-border);
    color: var(--color-primary);
  }

  .entity-icon--app {
    background: var(--color-surface-hover);
  }

  .entity-logo-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .entity-initials {
    font-weight: 700;
    font-size: 1.125rem;
    color: var(--color-text-muted);
    letter-spacing: 0.02em;
  }

  .entity-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
    text-align: center;
    line-height: 1.3;
    word-break: break-word;
  }

  .entity-role {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin: 0;
    text-align: center;
  }

  /* ── Center flow ─────────────────────────────────────────── */

  .flow-center {
    display: flex;
    align-items: stretch;
    position: relative;
    min-width: 0;
  }

  .flow-arrow {
    flex-shrink: 0;
    width: 2.25rem;
    align-self: stretch;
  }

  .flow-arrow svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .scopes-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.75rem 0;
    min-width: 10rem;
  }

  .scopes-heading {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-align: center;
    margin: 0 0 0.375rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .scopes-items {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .scope-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    border-radius: 6px;
    padding: 0.4rem 0.625rem;
  }

  .scope-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-primary);
    flex-shrink: 0;
  }

  .scope-text {
    font-size: 0.8125rem;
    color: var(--color-text);
    line-height: 1.4;
  }

  /* ── Actions ─────────────────────────────────────────────── */

  .consent-actions {
    display: flex;
    gap: 0.75rem;
  }

  .consent-actions .btn {
    flex: 1;
    padding: 0.625rem 1rem;
  }

  .consent-error {
    font-size: 0.875rem;
    color: var(--color-danger);
    text-align: center;
    margin: 0;
  }

  .consent-legal {
    font-size: 0.6875rem;
    color: var(--color-text-light);
    text-align: center;
    margin: 0;
    line-height: 1.5;
  }

  /* ── Loading skeleton ────────────────────────────────────── */

  .consent-loading {
    display: flex;
    justify-content: center;
  }

  .consent-card-loading {
    width: 100%;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 0.875rem;
    padding: 2rem;
  }

  /* ── Responsive (mobile — stacked) ──────────────────────── */

  @media (max-width: 600px) {
    .consent-wrapper {
      padding: 1.5rem 1.25rem 1.25rem;
      border-radius: 12px;
      gap: 1.25rem;
    }

    .consent-layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto auto auto;
    }

    /* On mobile: auth entity → scopes → app entity (top to bottom) */
    .entity-auth { order: 1; }
    .flow-center { order: 2; flex-direction: column; align-items: center; }
    .entity-app  { order: 3; }

    /* Rotate arrows for vertical flow */
    .flow-arrow {
      width: 1.5rem;
      height: 2.25rem;
      align-self: auto;
    }

    .flow-arrow--left svg {
      transform: rotate(90deg);
    }

    .flow-arrow--right svg {
      transform: rotate(90deg);
    }

    .scopes-list {
      padding: 0.5rem 0;
      min-width: 0;
      width: 100%;
    }

    .consent-actions .btn {
      padding: 0.5625rem 0.875rem;
    }
  }
</style>
