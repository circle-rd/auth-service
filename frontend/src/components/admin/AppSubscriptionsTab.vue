<script setup lang="ts">
    import { ref, watch } from "vue";
    import { useI18n } from "vue-i18n";
    import { Plus, Pencil, Trash2, AlertTriangle, Check } from "lucide-vue-next";
    import AppPlanModal from "./AppPlanModal.vue";

    const props = defineProps<{ appId: string; }>();
    const { t } = useI18n();

    interface PlanPrice {
        id: string;
        name: string;
        amount: number;
        currency: string;
        interval: "month" | "year" | "one_time";
        stripePriceId?: string | null;
    }

    interface Plan {
        id: string;
        name: string;
        description?: string | null;
        stripeProductId?: string | null;
        features: Record<string, unknown>;
        isDefault: boolean;
        prices: PlanPrice[];
    }

    const plans = ref<Plan[]>([]);
    const loading = ref(false);
    const stripeConfigured = ref(false);

    // Modal state
    const showModal = ref(false);
    const editingPlan = ref<Plan | null>(null);

    async function fetchServices() {
        try {
            const res = await fetch("/api/admin/services", { credentials: "include" });
            if (res.ok) {
                const data = (await res.json()) as { stripe: boolean; };
                stripeConfigured.value = data.stripe;
            }
        } catch {
            // ignore — banner just won't show
        }
    }

    async function fetchPlans() {
        loading.value = true;
        try {
            const res = await fetch(`/api/admin/applications/${props.appId}/plans`, {
                credentials: "include",
            });
            plans.value = ((await res.json()) as { plans: Plan[]; }).plans;
        } finally {
            loading.value = false;
        }
    }

    function openCreate() {
        editingPlan.value = null;
        showModal.value = true;
    }

    function openEdit(plan: Plan) {
        editingPlan.value = plan;
        showModal.value = true;
    }

    function onModalSaved() {
        showModal.value = false;
        void fetchPlans();
    }

    async function deletePlan(id: string) {
        await fetch(`/api/admin/applications/${props.appId}/plans/${id}`, {
            method: "DELETE",
            credentials: "include",
        });
        await fetchPlans();
    }

    function formatAmount(amount: number, currency: string): string {
        return new Intl.NumberFormat("en", {
            style: "currency",
            currency: currency.toUpperCase(),
            minimumFractionDigits: 2,
        }).format(amount / 100);
    }

    function featureDisplayValue(val: unknown): unknown {
        if (typeof val === "object" && val !== null && "value" in val) {
            return (val as Record<string, unknown>)["value"];
        }
        return val;
    }

    function featureHasUsage(val: unknown): boolean {
        return typeof val === "object" && val !== null && "usage" in val &&
            !!(val as Record<string, unknown>)["usage"];
    }

    watch(() => props.appId, async () => {
        await Promise.all([fetchServices(), fetchPlans()]);
    }, { immediate: true });
</script>

<template>
    <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
            <h1 class="text-xl font-semibold gradient-text">{{ t("admin.subscriptions") }}</h1>
            <button class="btn btn-primary text-sm" @click="openCreate">
                <Plus class="w-4 h-4" />
                {{ t("admin.createPlan") }}
            </button>
        </div>

        <!-- Stripe warning banner -->
        <div v-if="!stripeConfigured" class="flex items-start gap-3 p-4 rounded-xl"
            style="background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25)">
            <AlertTriangle class="w-5 h-5 shrink-0 mt-0.5" style="color: #f59e0b" />
            <p class="text-sm" style="color: #f59e0b">
                {{ t("admin.stripeNotConfigured") }}
            </p>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="text-sm text-center py-8" style="color: var(--color-text-muted)">
            {{ t("common.loading") }}
        </div>

        <!-- Empty state -->
        <div v-else-if="plans.length === 0" class="card text-center py-12">
            <p class="text-sm" style="color: var(--color-text-muted)">{{ t("admin.noPlans") }}</p>
            <button class="btn btn-primary mt-4" @click="openCreate">
                <Plus class="w-4 h-4" />
                {{ t("admin.createPlan") }}
            </button>
        </div>

        <!-- Plans list -->
        <div v-else class="space-y-4">
            <div v-for="plan in plans" :key="plan.id" class="card space-y-3">
                <!-- Plan header -->
                <div class="flex items-start gap-3">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-semibold">{{ plan.name }}</span>
                            <span v-if="plan.isDefault" class="badge badge-success text-xs">default</span>
                            <span v-if="plan.stripeProductId" class="text-xs font-mono px-2 py-0.5 rounded"
                                style="background: var(--color-bg); color: var(--color-text-muted)">
                                {{ plan.stripeProductId }}
                            </span>
                        </div>
                        <p v-if="plan.description" class="text-sm mt-0.5" style="color: var(--color-text-muted)">
                            {{ plan.description }}
                        </p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button class="btn btn-secondary text-xs px-3 py-1.5" @click="openEdit(plan)">
                            <Pencil class="w-3.5 h-3.5" />
                            {{ t("common.edit") }}
                        </button>
                        <button class="btn btn-ghost p-1.5" @click="deletePlan(plan.id)">
                            <Trash2 class="w-4 h-4" style="color: #f87171" />
                        </button>
                    </div>
                </div>

                <!-- Features summary -->
                <div v-if="Object.keys(plan.features).length > 0" class="flex flex-wrap gap-2">
                    <template v-for="(val, key) in plan.features" :key="key">
                        <div class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg"
                            style="background: var(--color-bg)">
                            <span class="font-mono" style="color: var(--color-text-muted)">{{ key }}</span>
                            <span class="font-medium">
                                {{ featureDisplayValue(val) }}
                            </span>
                            <Check v-if="featureHasUsage(val)" class="w-3 h-3" style="color: var(--color-primary)"
                                :title="t('admin.featureUsage')" />
                        </div>
                    </template>
                </div>

                <!-- Prices -->
                <div v-if="plan.prices.length > 0" class="grid gap-2"
                    style="grid-template-columns: repeat(auto-fill, minmax(180px, 1fr))">
                    <div v-for="price in plan.prices" :key="price.id" class="rounded-lg px-3 py-2.5"
                        style="background: var(--color-bg)">
                        <p class="font-medium text-sm">{{ price.name }}</p>
                        <p class="text-base font-semibold mt-0.5">
                            {{ formatAmount(Number(price.amount), price.currency) }}
                            <span class="text-xs font-normal" style="color: var(--color-text-muted)">
                                /{{ price.interval === "one_time" ? t("admin.priceIntervalOneTime") : price.interval ===
                                    "year" ?
                                    t("admin.priceIntervalYear") : t("admin.priceIntervalMonth") }}
                            </span>
                        </p>
                        <p v-if="price.stripePriceId" class="text-xs font-mono mt-1 truncate"
                            :title="price.stripePriceId" style="color: var(--color-text-muted); opacity: 0.6">
                            {{ price.stripePriceId }}
                        </p>
                    </div>
                </div>
            </div>
        </div>

        <!-- AppPlanModal -->
        <AppPlanModal v-if="showModal" :app-id="appId" :plan="editingPlan" :stripe-configured="stripeConfigured"
            @close="showModal = false" @saved="onModalSaved" />
    </div>
</template>
