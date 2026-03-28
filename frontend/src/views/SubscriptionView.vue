<script setup lang="ts">
  import { ref, onMounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { CreditCard, BarChart2, ChevronDown, ChevronUp } from "lucide-vue-next";

  const { t } = useI18n();

  interface Plan {
    id: string;
    name: string;
    description?: string | null;
    features: Record<string, unknown>;
    isDefault: boolean;
  }

  interface Subscription {
    applicationId: string;
    applicationName: string;
    applicationSlug: string;
    applicationIcon?: string | null;
    isActive: boolean;
    plan: Plan | null;
  }

  interface Aggregate {
    key: string;
    total: string;
    updatedAt: string;
  }

  const subscriptions = ref<Subscription[]>([]);
  const loading = ref(false);
  const error = ref("");

  // Consumption per app — lazy loaded on expand
  const consumption = ref<Record<string, Aggregate[]>>({});
  const loadingConsumption = ref<Set<string>>(new Set());
  const expandedApps = ref<Set<string>>(new Set());

  async function fetchSubscriptions(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const res = await fetch("/api/user/subscription", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load subscriptions");
      const data = (await res.json()) as { subscriptions: Subscription[]; };
      subscriptions.value = data.subscriptions;
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t("errors.SRV_001");
    } finally {
      loading.value = false;
    }
  }

  async function toggleConsumption(appId: string): Promise<void> {
    if (expandedApps.value.has(appId)) {
      expandedApps.value = new Set([...expandedApps.value].filter((id) => id !== appId));
      return;
    }
    expandedApps.value = new Set([...expandedApps.value, appId]);
    if (consumption.value[appId]) return; // already loaded

    loadingConsumption.value = new Set([...loadingConsumption.value, appId]);
    try {
      const res = await fetch(`/api/user/consumption/${appId}`, { credentials: "include" });
      if (!res.ok) {
        consumption.value[appId] = [];
        return;
      }
      const data = (await res.json()) as { aggregates: Aggregate[]; };
      consumption.value[appId] = data.aggregates;
    } finally {
      loadingConsumption.value = new Set([...loadingConsumption.value].filter((id) => id !== appId));
    }
  }

  function initials(name: string): string {
    return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
  }

  function formatFeatureValue(val: unknown): string {
    if (typeof val === "boolean") return val ? "✓ Oui" : "✗ Non";
    if (typeof val === "number") return val.toLocaleString("fr-FR");
    return String(val);
  }

  onMounted(fetchSubscriptions);
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold gradient-text">{{ t("profile.subscription") }}</h1>
    <p class="text-sm" style="color: var(--text-muted)">
      Vos plans actifs et métriques de consommation par application.
    </p>

    <div v-if="error" class="card" style="border-color: rgba(239,68,68,0.3)">
      <p class="text-sm" style="color: #f87171">{{ error }}</p>
    </div>

    <div v-if="loading" class="text-center py-8" style="color: var(--text-muted)">
      {{ t("common.loading") }}
    </div>

    <div v-else-if="subscriptions.length === 0" class="card text-center py-8">
      <p class="text-sm" style="color: var(--text-muted)">
        Vous n'avez accès à aucune application pour le moment.
      </p>
    </div>

    <div v-else class="space-y-4">
      <div v-for="sub in subscriptions" :key="sub.applicationId" class="card space-y-4">
        <!-- App header -->
        <div class="flex items-center gap-3">
          <img v-if="sub.applicationIcon" :src="sub.applicationIcon" :alt="sub.applicationName"
            class="w-8 h-8 rounded-lg object-cover shrink-0" />
          <div v-else class="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold font-mono shrink-0"
            style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
            {{ initials(sub.applicationName) }}
          </div>
          <div>
            <p class="font-semibold">{{ sub.applicationName }}</p>
            <p class="text-xs font-mono" style="color: var(--text-muted)">{{ sub.applicationSlug }}</p>
          </div>
        </div>

        <!-- Plan -->
        <div v-if="sub.plan" class="space-y-3">
          <div class="flex items-center gap-2">
            <CreditCard class="w-4 h-4 shrink-0" style="color: var(--accent-cyan)" />
            <span class="text-sm font-medium">Plan <strong>{{ sub.plan.name }}</strong></span>
            <span v-if="sub.plan.isDefault" class="badge badge-inactive text-xs">Défaut</span>
          </div>
          <p v-if="sub.plan.description" class="text-sm" style="color: var(--text-muted)">
            {{ sub.plan.description }}
          </p>
          <!-- Features -->
          <div v-if="Object.keys(sub.plan.features).length > 0" class="rounded-lg overflow-hidden"
            style="border: 1px solid var(--border)">
            <table class="w-full text-sm">
              <thead>
                <tr style="background: var(--bg-secondary)">
                  <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                    style="color: var(--text-muted)">Fonctionnalité</th>
                  <th class="text-right px-3 py-2 text-xs font-mono uppercase tracking-widest"
                    style="color: var(--text-muted)">Valeur</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(val, key) in sub.plan.features" :key="String(key)"
                  style="border-top: 1px solid var(--border)">
                  <td class="px-3 py-2 font-mono text-xs">{{ key }}</td>
                  <td class="px-3 py-2 text-right font-mono text-xs"
                    :style="val === true ? 'color: var(--accent-cyan)' : val === false ? 'color: var(--text-muted)' : ''">
                    {{ formatFeatureValue(val) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-sm" style="color: var(--text-muted)">Aucune fonctionnalité définie.</p>
        </div>

        <div v-else class="flex items-center gap-2">
          <span class="badge badge-inactive text-xs">Plan gratuit / aucun plan</span>
        </div>

        <!-- Consumption toggle -->
        <button class="flex items-center gap-2 text-sm transition-colors" style="color: var(--text-muted)"
          @click="toggleConsumption(sub.applicationId)">
          <BarChart2 class="w-4 h-4" />
          Consommation
          <ChevronDown v-if="!expandedApps.has(sub.applicationId)" class="w-3.5 h-3.5 ml-auto" />
          <ChevronUp v-else class="w-3.5 h-3.5 ml-auto" />
        </button>

        <!-- Consumption data (expanded) -->
        <div v-if="expandedApps.has(sub.applicationId)">
          <div v-if="loadingConsumption.has(sub.applicationId)" class="text-sm" style="color: var(--text-muted)">
            {{ t("common.loading") }}
          </div>
          <div v-else-if="(consumption[sub.applicationId] ?? []).length === 0" class="text-sm"
            style="color: var(--text-muted)">
            Aucune donnée de consommation.
          </div>
          <div v-else class="rounded-lg overflow-hidden" style="border: 1px solid var(--border)">
            <table class="w-full text-sm">
              <thead>
                <tr style="background: var(--bg-secondary)">
                  <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                    style="color: var(--text-muted)">Clé</th>
                  <th class="text-right px-3 py-2 text-xs font-mono uppercase tracking-widest"
                    style="color: var(--text-muted)">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="agg in consumption[sub.applicationId]" :key="agg.key"
                  style="border-top: 1px solid var(--border)">
                  <td class="px-3 py-2 font-mono text-xs">{{ agg.key }}</td>
                  <td class="px-3 py-2 text-right font-mono text-xs font-medium" style="color: var(--accent-cyan)">
                    {{ Number(agg.total).toLocaleString("fr-FR") }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
