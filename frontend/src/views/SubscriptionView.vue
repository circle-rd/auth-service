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
    if (typeof val === "boolean") return val ? "✓ Yes" : "✗ No";
    if (typeof val === "number") return val.toLocaleString();
    return String(val);
  }

  onMounted(fetchSubscriptions);
</script>

<template>
  <div class="sub-root">
    <div class="view-header">
      <h1 class="view-title">{{ t("profile.subscription") }}</h1>
      <p class="view-desc">Your active plans and consumption metrics per application.</p>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="loading" class="sub-loading">{{ t("common.loading") }}</div>

    <div v-else-if="subscriptions.length === 0" class="sub-empty">
      <p>You don't have access to any applications yet.</p>
    </div>

    <div v-else class="sub-list">
      <div v-for="sub in subscriptions" :key="sub.applicationId" class="sub-card">
        <!-- App header -->
        <div class="app-header">
          <img v-if="sub.applicationIcon" :src="sub.applicationIcon" :alt="sub.applicationName" class="app-icon-img" />
          <div v-else class="app-icon-placeholder">
            {{ initials(sub.applicationName) }}
          </div>
          <div>
            <p class="app-name">{{ sub.applicationName }}</p>
            <p class="app-slug">{{ sub.applicationSlug }}</p>
          </div>
        </div>

        <!-- Plan -->
        <div v-if="sub.plan" class="plan-section">
          <div class="plan-header">
            <CreditCard class="w-4 h-4 shrink-0" style="color: var(--color-primary)" />
            <span class="text-sm font-medium">Plan <strong>{{ sub.plan.name }}</strong></span>
            <span v-if="sub.plan.isDefault" class="badge badge-inactive">Default</span>
          </div>
          <p v-if="sub.plan.description" class="plan-desc">{{ sub.plan.description }}</p>
          <!-- Features -->
          <div v-if="Object.keys(sub.plan.features).length > 0" class="features-table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th class="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(val, key) in sub.plan.features" :key="String(key)">
                  <td class="font-mono text-xs">{{ key }}</td>
                  <td class="text-right font-mono text-xs"
                    :style="val === true ? 'color: var(--color-success)' : val === false ? 'color: var(--color-text-muted)' : ''">
                    {{ formatFeatureValue(val) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-sm" style="color: var(--color-text-muted)">No features defined.</p>
        </div>

        <div v-else class="plan-section">
          <span class="badge badge-inactive">Free / No plan</span>
        </div>

        <!-- Consumption toggle -->
        <button class="consumption-toggle" @click="toggleConsumption(sub.applicationId)">
          <BarChart2 class="w-4 h-4" />
          Consumption
          <ChevronDown v-if="!expandedApps.has(sub.applicationId)" class="w-3.5 h-3.5 ml-auto" />
          <ChevronUp v-else class="w-3.5 h-3.5 ml-auto" />
        </button>

        <!-- Consumption data (expanded) -->
        <div v-if="expandedApps.has(sub.applicationId)">
          <div v-if="loadingConsumption.has(sub.applicationId)" class="text-sm" style="color: var(--color-text-muted)">
            {{ t("common.loading") }}
          </div>
          <div v-else-if="(consumption[sub.applicationId] ?? []).length === 0" class="text-sm"
            style="color: var(--color-text-muted)">
            No consumption data.
          </div>
          <div v-else class="features-table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th class="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="agg in consumption[sub.applicationId]" :key="agg.key">
                  <td class="font-mono text-xs">{{ agg.key }}</td>
                  <td class="text-right font-mono text-xs font-medium" style="color: var(--color-primary)">
                    {{ Number(agg.total).toLocaleString() }}
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

<style scoped>
  .sub-root {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .view-header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
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
    margin: 0;
  }

  .sub-loading {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .sub-empty {
    text-align: center;
    padding: 2rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .sub-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .sub-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .app-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .app-icon-img {
    width: 2rem;
    height: 2rem;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .app-icon-placeholder {
    width: 2rem;
    height: 2rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6875rem;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
    flex-shrink: 0;
    background: var(--color-primary-light);
    color: var(--color-primary);
    border: 1px solid var(--color-primary-border);
  }

  .app-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .app-slug {
    font-size: 0.75rem;
    font-family: 'JetBrains Mono', monospace;
    color: var(--color-text-muted);
    margin: 0;
  }

  .plan-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .plan-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .plan-desc {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .features-table-wrap {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }

  .consumption-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    width: 100%;
    transition: color 0.15s ease;
    font-family: inherit;
  }

  .consumption-toggle:hover {
    color: var(--color-text);
  }
</style>
