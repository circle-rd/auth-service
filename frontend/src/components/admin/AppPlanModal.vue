<script setup lang="ts">
    import { ref, computed, watch } from "vue";
    import { useI18n } from "vue-i18n";
    import {
        X,
        Info,
        Layers,
        DollarSign,
        Plus,
        Trash2,
        AlertTriangle,
    } from "lucide-vue-next";

    // ── Types ─────────────────────────────────────────────────────────────────

    interface PlanPrice {
        id?: string;
        name: string;
        amount: number; // in cents
        currency: string;
        interval: "month" | "year" | "one_time";
        stripePriceId?: string | null;
    }

    interface Plan {
        id?: string;
        name: string;
        description?: string | null;
        stripeProductId?: string | null;
        features: Record<string, unknown>;
        isDefault: boolean;
        prices?: PlanPrice[];
    }

    /** Internal model for a feature row in the form view */
    interface FeatureRow {
        key: string; // display name (user-facing)
        value: string;
        usage: boolean;
        hasExtraKeys: boolean; // true if the stored JSON entry has unexpected extra keys
    }

    const props = defineProps<{
        appId: string;
        plan?: Plan | null; // null / undefined = create mode
        stripeConfigured: boolean;
    }>();

    const emit = defineEmits<{
        (e: "close"): void;
        (e: "saved", plan: Plan): void;
    }>();

    const { t } = useI18n();

    // ── Tab navigation ────────────────────────────────────────────────────────

    type TabId = "info" | "features" | "pricing";
    const tabs: { id: TabId; label: string; icon: typeof Info; }[] = [
        { id: "info", label: t("admin.planInfo"), icon: Info },
        { id: "features", label: t("admin.planFeatures"), icon: Layers },
        { id: "pricing", label: t("admin.planPricing"), icon: DollarSign },
    ];
    const activeTab = ref<TabId>("info");

    // ── Plan form state ───────────────────────────────────────────────────────

    const form = ref({
        name: "",
        description: "",
        isDefault: false,
    });

    const saving = ref(false);
    const error = ref<string | null>(null);

    // ── Features state ────────────────────────────────────────────────────────

    const featuresMode = ref<"form" | "advanced">("form");
    const featureRows = ref<FeatureRow[]>([]);
    const featuresJson = ref("{}");
    const featuresJsonValid = ref(true);

    /** Convert a display name → lower_snake_case JSON key */
    function toSnakeKey(name: string): string {
        return name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9 _]/g, "")
            .replace(/\s+/g, "_");
    }

    /** Build the features JSON object from the current form rows */
    function rowsToJson(rows: FeatureRow[]): Record<string, unknown> {
        const obj: Record<string, unknown> = {};
        for (const row of rows) {
            if (!row.key.trim()) continue;
            const k = toSnakeKey(row.key);
            obj[k] = { name: row.key, value: row.value, usage: row.usage };
        }
        return obj;
    }

    /** Parse a features JSON object into form rows */
    function jsonToRows(json: Record<string, unknown>): FeatureRow[] {
        return Object.entries(json).map(([, val]) => {
            const entry = (typeof val === "object" && val !== null ? val : {}) as Record<string, unknown>;
            const { name, value, usage, ...rest } = entry;
            return {
                key: typeof name === "string" ? name : "",
                value: typeof value === "string" ? value : String(value ?? ""),
                usage: typeof usage === "boolean" ? usage : false,
                hasExtraKeys: Object.keys(rest).length > 0,
            };
        });
    }

    /** Sync form rows → advanced JSON text */
    function syncRowsToJson(): void {
        try {
            featuresJson.value = JSON.stringify(rowsToJson(featureRows.value), null, 2);
            featuresJsonValid.value = true;
        } catch {
            featuresJsonValid.value = false;
        }
    }

    /** Sync advanced JSON text → form rows */
    function syncJsonToRows(): boolean {
        try {
            const parsed = JSON.parse(featuresJson.value) as Record<string, unknown>;
            featureRows.value = jsonToRows(parsed);
            featuresJsonValid.value = true;
            return true;
        } catch {
            featuresJsonValid.value = false;
            return false;
        }
    }

    function switchToAdvanced(): void {
        syncRowsToJson();
        featuresMode.value = "advanced";
    }

    function switchToForm(): void {
        if (!syncJsonToRows()) return; // stay in advanced if JSON is invalid
        featuresMode.value = "form";
    }

    function addFeatureRow(): void {
        featureRows.value.push({ key: "", value: "", usage: false, hasExtraKeys: false });
    }

    function removeFeatureRow(index: number): void {
        featureRows.value.splice(index, 1);
        syncRowsToJson();
    }

    function onRowChange(): void {
        syncRowsToJson();
    }

    // ── Pricing state ─────────────────────────────────────────────────────────

    const pricesToCreate = ref<PlanPrice[]>([]);
    const existingPrices = ref<PlanPrice[]>([]);
    const pricesToDelete = ref<string[]>([]); // IDs of existing prices to remove

    const newPrice = ref<PlanPrice>({
        name: "",
        amount: 0,
        currency: "usd",
        interval: "month",
    });

    function addPriceRow(): void {
        if (!newPrice.value.name || newPrice.value.amount <= 0) return;
        pricesToCreate.value.push({ ...newPrice.value });
        newPrice.value = { name: "", amount: 0, currency: "usd", interval: "month" };
    }

    function removePendingPrice(index: number): void {
        pricesToCreate.value.splice(index, 1);
    }

    function markExistingPriceForDeletion(priceId: string): void {
        pricesToDelete.value.push(priceId);
        existingPrices.value = existingPrices.value.filter((p) => p.id !== priceId);
    }

    function formatAmount(amount: number, currency: string): string {
        return new Intl.NumberFormat("en", {
            style: "currency",
            currency: currency.toUpperCase(),
            minimumFractionDigits: 2,
        }).format(amount / 100);
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    watch(
        () => props.plan,
        (plan) => {
            if (plan) {
                form.value = {
                    name: plan.name,
                    description: plan.description ?? "",
                    isDefault: plan.isDefault,
                };
                const features = (plan.features ?? {}) as Record<string, unknown>;
                featureRows.value = jsonToRows(features);
                featuresJson.value = JSON.stringify(features, null, 2);
                existingPrices.value = (plan.prices ?? []).map((p) => ({ ...p }));
            } else {
                form.value = { name: "", description: "", isDefault: false };
                featureRows.value = [];
                featuresJson.value = "{}";
                existingPrices.value = [];
            }
            pricesToCreate.value = [];
            pricesToDelete.value = [];
            error.value = null;
            activeTab.value = "info";
            featuresMode.value = "form";
        },
        { immediate: true },
    );

    // ── Save ──────────────────────────────────────────────────────────────────

    async function save(): Promise<void> {
        error.value = null;

        // Validate features JSON
        let features: Record<string, unknown>;
        if (featuresMode.value === "advanced") {
            if (!featuresJsonValid.value) {
                error.value = t("admin.featuresJsonInvalid");
                activeTab.value = "features";
                return;
            }
            try {
                features = JSON.parse(featuresJson.value) as Record<string, unknown>;
            } catch {
                error.value = t("admin.featuresJsonInvalid");
                activeTab.value = "features";
                return;
            }
        } else {
            syncRowsToJson();
            features = rowsToJson(featureRows.value);
        }

        saving.value = true;
        try {
            let savedPlan: Plan;

            if (props.plan?.id) {
                // Edit existing plan
                const res = await fetch(
                    `/api/admin/applications/${props.appId}/plans/${props.plan.id}`,
                    {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({
                            name: form.value.name,
                            description: form.value.description || null,
                            features,
                            isDefault: form.value.isDefault,
                        }),
                    },
                );
                if (!res.ok) {
                    const data = (await res.json().catch(() => ({}))) as { message?: string; };
                    error.value = data.message ?? t("errors.SRV_001");
                    return;
                }
                savedPlan = ((await res.json()) as { plan: Plan; }).plan;
            } else {
                // Create new plan
                const res = await fetch(
                    `/api/admin/applications/${props.appId}/plans`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({
                            name: form.value.name,
                            description: form.value.description || null,
                            features,
                            isDefault: form.value.isDefault,
                        }),
                    },
                );
                if (!res.ok) {
                    const data = (await res.json().catch(() => ({}))) as { message?: string; };
                    error.value = data.message ?? t("errors.SRV_001");
                    return;
                }
                savedPlan = ((await res.json()) as { plan: Plan; }).plan;
            }

            const planId = savedPlan.id!;

            // Delete marked prices
            for (const priceId of pricesToDelete.value) {
                await fetch(
                    `/api/admin/applications/${props.appId}/plans/${planId}/prices/${priceId}`,
                    { method: "DELETE", credentials: "include" },
                );
            }

            // Create new prices
            for (const price of pricesToCreate.value) {
                await fetch(
                    `/api/admin/applications/${props.appId}/plans/${planId}/prices`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({
                            name: price.name,
                            amount: price.amount,
                            currency: price.currency,
                            interval: price.interval,
                        }),
                    },
                );
            }

            emit("saved", savedPlan);
        } finally {
            saving.value = false;
        }
    }

    // ── Computed helpers ──────────────────────────────────────────────────────

    const isEditMode = computed(() => !!props.plan?.id);

    const jsonTextareaRows = computed(() => {
        const lines = featuresJson.value.split("\n").length;
        return Math.max(10, Math.min(lines + 2, 30));
    });
</script>

<template>
    <!-- Overlay -->
    <Teleport to="body">
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4" style="background: rgba(0,0,0,0.6)"
            @click.self="emit('close')">
            <div class="relative w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col overflow-hidden"
                style="background: var(--color-surface); max-height: 90vh" @click.stop>

                <!-- Header -->
                <div class="flex items-center gap-3 px-6 py-4 border-b shrink-0"
                    style="border-color: var(--color-border)">
                    <h2 class="font-semibold text-base flex-1">
                        {{ isEditMode ? t("admin.editPlan") : t("admin.createPlan") }}
                    </h2>
                    <button class="btn btn-ghost p-1.5" @click="emit('close')">
                        <X class="w-4 h-4" />
                    </button>
                </div>

                <!-- Tab bar -->
                <div class="flex border-b shrink-0 overflow-x-auto" style="border-color: var(--color-border)">
                    <button v-for="tab in tabs" :key="tab.id"
                        class="flex items-center gap-2 px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors"
                        :style="activeTab === tab.id
                            ? 'color: var(--color-primary); border-bottom: 2px solid var(--color-primary)'
                            : 'color: var(--color-text-muted)'" @click="activeTab = tab.id">
                        <component :is="tab.icon" class="w-4 h-4" />
                        {{ tab.label }}
                    </button>
                </div>

                <!-- Scrollable body -->
                <div class="overflow-y-auto flex-1 px-6 py-5 space-y-5">

                    <!-- ── Info tab ─────────────────────────────────────── -->
                    <template v-if="activeTab === 'info'">
                        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--color-text-muted)">
                                    {{ t("common.name") }}
                                </label>
                                <input v-model="form.name" class="input" :placeholder="t('admin.appName')" required />
                            </div>
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--color-text-muted)">
                                    {{ t("admin.planDescription") }}
                                    <span style="opacity:0.55">({{ t("common.optional") }})</span>
                                </label>
                                <input v-model="form.description" class="input" :placeholder="t('common.optional')" />
                            </div>
                        </div>

                        <!-- Default plan toggle -->
                        <label class="flex items-center gap-2.5 cursor-pointer select-none">
                            <input v-model="form.isDefault" type="checkbox" class="sr-only" />
                            <div class="w-9 h-5 rounded-full transition-colors shrink-0"
                                :style="form.isDefault ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                    :style="form.isDefault ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                            </div>
                            <span class="text-sm">{{ t("admin.isDefault") }}</span>
                        </label>
                    </template>

                    <!-- ── Features tab ────────────────────────────────── -->
                    <template v-else-if="activeTab === 'features'">

                        <!-- Mode switcher -->
                        <div class="flex items-center gap-2 text-xs">
                            <button class="btn btn-sm transition-colors"
                                :class="featuresMode === 'form' ? 'btn-primary' : 'btn-secondary'"
                                @click="featuresMode === 'advanced' ? switchToForm() : void 0">
                                {{ t("admin.featuresFormView") }}
                            </button>
                            <button class="btn btn-sm transition-colors"
                                :class="featuresMode === 'advanced' ? 'btn-primary' : 'btn-secondary'"
                                @click="featuresMode === 'form' ? switchToAdvanced() : void 0">
                                {{ t("admin.featuresAdvancedView") }}
                            </button>
                        </div>

                        <!-- Form view -->
                        <template v-if="featuresMode === 'form'">
                            <div v-if="featureRows.length === 0" class="text-sm text-center py-6"
                                style="color: var(--color-text-muted)">
                                {{ t("admin.noPlans") }}
                            </div>

                            <div v-for="(row, idx) in featureRows" :key="idx" class="grid gap-3 p-4 rounded-xl"
                                style="background: var(--color-bg); grid-template-columns: 1fr 1fr auto auto auto">

                                <!-- Key -->
                                <div>
                                    <label class="block text-xs mb-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.featureKey") }}
                                    </label>
                                    <input v-model="row.key" class="input text-sm"
                                        :placeholder="t('admin.featureKeyPlaceholder')" @input="onRowChange" />
                                    <p v-if="row.key" class="text-xs mt-1 font-mono"
                                        style="color: var(--color-text-muted)">
                                        {{ toSnakeKey(row.key) }}
                                    </p>
                                </div>

                                <!-- Value -->
                                <div>
                                    <label class="block text-xs mb-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.featureValue") }}
                                    </label>
                                    <input v-model="row.value" class="input text-sm"
                                        :placeholder="t('admin.featureValuePlaceholder')" @input="onRowChange" />
                                </div>

                                <!-- Usage toggle -->
                                <div class="flex flex-col items-center justify-center gap-1 pt-1">
                                    <label class="text-xs" style="color: var(--color-text-muted)">
                                        {{ t("admin.featureUsage") }}
                                    </label>
                                    <button type="button" class="w-9 h-5 rounded-full transition-colors"
                                        :style="row.usage ? 'background: var(--color-primary)' : 'background: var(--color-border)'"
                                        @click="row.usage = !row.usage; onRowChange()">
                                        <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                            :style="row.usage ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                                    </button>
                                </div>

                                <!-- Extra keys warning -->
                                <div v-if="row.hasExtraKeys" class="flex items-center"
                                    :title="t('admin.featureExtraKeys')">
                                    <AlertTriangle class="w-4 h-4" style="color: #f59e0b" />
                                </div>
                                <div v-else />

                                <!-- Delete -->
                                <button class="btn btn-ghost p-1 self-end" @click="removeFeatureRow(idx)">
                                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                                </button>
                            </div>

                            <button class="btn btn-secondary text-sm w-full" @click="addFeatureRow">
                                <Plus class="w-4 h-4" />
                                {{ t("admin.addFeature") }}
                            </button>
                        </template>

                        <!-- Advanced JSON view -->
                        <template v-else>
                            <div>
                                <textarea v-model="featuresJson" class="input font-mono text-sm w-full resize-none"
                                    :rows="jsonTextareaRows" spellcheck="false" @input="syncJsonToRows" />
                                <p v-if="!featuresJsonValid" class="text-sm mt-2" style="color: #f87171">
                                    {{ t("admin.invalidFeaturesJson") }}
                                </p>
                            </div>
                        </template>
                    </template>

                    <!-- ── Pricing tab ──────────────────────────────────── -->
                    <template v-else-if="activeTab === 'pricing'">

                        <!-- Stripe warning -->
                        <div v-if="!stripeConfigured" class="flex items-start gap-3 p-4 rounded-xl"
                            style="background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3)">
                            <AlertTriangle class="w-5 h-5 shrink-0 mt-0.5" style="color: #f59e0b" />
                            <p class="text-sm" style="color: #f59e0b">
                                {{ t("admin.stripeNotConfigured") }}
                            </p>
                        </div>

                        <!-- Existing prices -->
                        <div v-if="existingPrices.length > 0" class="space-y-2">
                            <div v-for="price in existingPrices" :key="price.id"
                                class="flex items-center gap-3 px-4 py-3 rounded-xl"
                                style="background: var(--color-bg)">
                                <div class="flex-1">
                                    <p class="font-medium text-sm">{{ price.name }}</p>
                                    <p class="text-xs" style="color: var(--color-text-muted)">
                                        {{ formatAmount(price.amount, price.currency) }} /
                                        {{ price.interval === "one_time" ? t("admin.priceIntervalOneTime") :
                                            price.interval === "year" ? t("admin.priceIntervalYear") :
                                                t("admin.priceIntervalMonth") }}
                                    </p>
                                    <p v-if="price.stripePriceId" class="text-xs font-mono mt-0.5"
                                        style="color: var(--color-text-muted); opacity: 0.6">
                                        {{ price.stripePriceId }}
                                    </p>
                                </div>
                                <button class="btn btn-ghost p-1.5" @click="markExistingPriceForDeletion(price.id!)">
                                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                                </button>
                            </div>
                        </div>

                        <!-- New prices pending creation -->
                        <div v-if="pricesToCreate.length > 0" class="space-y-2">
                            <div v-for="(price, idx) in pricesToCreate" :key="idx"
                                class="flex items-center gap-3 px-4 py-3 rounded-xl"
                                style="background: var(--color-bg); border: 1px dashed var(--color-border)">
                                <div class="flex-1">
                                    <p class="font-medium text-sm">{{ price.name }}
                                        <span class="text-xs ml-2 px-1.5 py-0.5 rounded"
                                            style="background: var(--color-primary-light); color: var(--color-primary)">
                                            pending
                                        </span>
                                    </p>
                                    <p class="text-xs" style="color: var(--color-text-muted)">
                                        {{ formatAmount(price.amount, price.currency) }} /
                                        {{ price.interval === "one_time" ? t("admin.priceIntervalOneTime") :
                                            price.interval === "year" ? t("admin.priceIntervalYear") :
                                                t("admin.priceIntervalMonth") }}
                                    </p>
                                </div>
                                <button class="btn btn-ghost p-1.5" @click="removePendingPrice(idx)">
                                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                                </button>
                            </div>
                        </div>

                        <div v-if="existingPrices.length === 0 && pricesToCreate.length === 0"
                            class="text-sm text-center py-4" style="color: var(--color-text-muted)">
                            {{ t("admin.noPrices") }}
                        </div>

                        <!-- Add price form -->
                        <div class="rounded-xl p-4 space-y-4" style="background: var(--color-bg)">
                            <p class="text-xs font-mono uppercase tracking-widest"
                                style="color: var(--color-text-muted)">
                                {{ t("admin.addPrice") }}
                            </p>

                            <div class="grid gap-3" style="grid-template-columns: 1fr 1fr">
                                <!-- Tier name -->
                                <div>
                                    <label class="block text-xs mb-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.priceName") }}
                                    </label>
                                    <input v-model="newPrice.name" class="input text-sm"
                                        :placeholder="t('admin.priceIntervalMonth')" />
                                </div>

                                <!-- Amount -->
                                <div>
                                    <label class="block text-xs mb-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.priceAmount") }}
                                        <span style="opacity: 0.55">(cents)</span>
                                    </label>
                                    <input v-model.number="newPrice.amount" type="number" min="1" class="input text-sm"
                                        placeholder="900" />
                                </div>

                                <!-- Currency -->
                                <div>
                                    <label class="block text-xs mb-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.priceCurrency") }}
                                    </label>
                                    <input v-model="newPrice.currency" class="input text-sm font-mono" placeholder="usd"
                                        maxlength="3" />
                                </div>

                                <!-- Interval -->
                                <div>
                                    <label class="block text-xs mb-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.priceInterval") }}
                                    </label>
                                    <select v-model="newPrice.interval" class="input text-sm">
                                        <option value="month">{{ t("admin.priceIntervalMonth") }}</option>
                                        <option value="year">{{ t("admin.priceIntervalYear") }}</option>
                                        <option value="one_time">{{ t("admin.priceIntervalOneTime") }}</option>
                                    </select>
                                </div>
                            </div>

                            <button class="btn btn-secondary text-sm" :disabled="!newPrice.name || newPrice.amount <= 0"
                                @click="addPriceRow">
                                <Plus class="w-4 h-4" />
                                {{ t("admin.addPrice") }}
                            </button>
                        </div>
                    </template>

                </div>

                <!-- Footer -->
                <div class="flex items-center justify-between gap-4 px-6 py-4 border-t shrink-0"
                    style="border-color: var(--color-border)">
                    <p v-if="error" class="text-sm flex-1" style="color: #f87171">{{ error }}</p>
                    <div v-else class="flex-1" />
                    <div class="flex items-center gap-3">
                        <button class="btn btn-secondary" :disabled="saving" @click="emit('close')">
                            {{ t("common.cancel") }}
                        </button>
                        <button class="btn btn-primary" :disabled="saving || !form.name" @click="save">
                            {{ saving ? t("common.saving") : t("common.save") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>
