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
  <div class="min-h-screen flex items-center justify-center px-4 pt-16">
    <div class="w-full max-w-sm">
      <div class="mb-8 text-center">
        <ShieldCheck class="w-12 h-12 mx-auto mb-3" style="color: var(--accent)" />
        <h1 class="text-2xl font-bold gradient-text mb-2">{{ t("consent.title") }}</h1>
        <p v-if="!loading" class="text-sm" style="color: var(--text-muted)">
          {{ t("consent.requestingAccess", { app: clientName }) }}
        </p>
      </div>

      <div v-if="loading" class="card text-center py-8" style="color: var(--text-muted)">
        {{ t("common.loading") }}
      </div>

      <div v-else class="card space-y-5">
        <!-- Requested scopes -->
        <div>
          <p class="text-sm font-medium mb-3">{{ t("consent.scopes") }}</p>
          <ul class="space-y-2">
            <li v-for="scope in scopes" :key="scope" class="flex items-center gap-2 text-sm">
              <ShieldCheck class="w-4 h-4 shrink-0" style="color: var(--accent)" />
              <span>{{ t(`consent.scope.${scope}`, scope) }}</span>
            </li>
          </ul>
        </div>

        <p v-if="error" class="text-sm text-red-400">{{ error }}</p>

        <!-- Actions -->
        <div class="flex gap-3">
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
