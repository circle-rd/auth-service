<script setup lang="ts">
    import { ref, computed, onMounted } from "vue";

    const props = defineProps<{ appId: string; }>();

    interface Entry {
        userId: string;
        userName?: string | null;
        userEmail?: string | null;
        key: string;
        total: string;
        updatedAt: string;
    }

    const entries = ref<Entry[]>([]);
    const loading = ref(false);
    const search = ref("");

    async function fetchConsumption(): Promise<void> {
        loading.value = true;
        try {
            const res = await fetch(`/api/admin/applications/${props.appId}/consumption`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data = (await res.json()) as { entries: Entry[]; };
            entries.value = data.entries;
        } finally {
            loading.value = false;
        }
    }

    const filtered = computed(() => {
        const q = search.value.toLowerCase();
        if (!q) return entries.value;
        return entries.value.filter(
            (e) =>
                (e.userName ?? "").toLowerCase().includes(q) ||
                (e.userEmail ?? "").toLowerCase().includes(q) ||
                e.key.toLowerCase().includes(q),
        );
    });

    function initials(name?: string | null): string {
        if (!name) return "?";
        return name
            .split(" ")
            .map((w) => w[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
    }

    onMounted(fetchConsumption);
</script>

<template>
    <div class="space-y-4">
        <!-- Search -->
        <input v-model="search" type="search" placeholder="Search by user or key…" class="input w-full" />

        <div v-if="loading" class="text-center py-8 text-sm" style="color: var(--color-text-muted)">
            Loading…
        </div>

        <div v-else-if="filtered.length === 0" class="text-center py-8 text-sm" style="color: var(--color-text-muted)">
            {{ search ? "No results." : "No consumption data." }}
        </div>

        <div v-else class="rounded-lg overflow-hidden" style="border: 1px solid var(--color-border)">
            <table class="w-full text-sm">
                <thead>
                    <tr style="background: var(--color-bg)">
                        <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                            style="color: var(--color-text-muted)">
                            Utilisateur
                        </th>
                        <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                            style="color: var(--color-text-muted)">
                            Clé
                        </th>
                        <th class="text-right px-3 py-2 text-xs font-mono uppercase tracking-widest"
                            style="color: var(--color-text-muted)">
                            Total
                        </th>
                        <th class="text-right px-3 py-2 text-xs font-mono uppercase tracking-widest"
                            style="color: var(--color-text-muted)">
                            Mis à jour
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="entry in filtered" :key="`${entry.userId}-${entry.key}`"
                        style="border-top: 1px solid var(--color-border)">
                        <td class="px-3 py-2.5">
                            <div class="flex items-center gap-2">
                                <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                                    style="background: var(--color-primary-light); color: var(--color-primary)">
                                    {{ initials(entry.userName) }}
                                </div>
                                <div>
                                    <p class="font-medium leading-tight">{{ entry.userName ?? "—" }}</p>
                                    <p class="text-xs" style="color: var(--color-text-muted)">{{ entry.userEmail ??
                                        entry.userId }}</p>
                                </div>
                            </div>
                        </td>
                        <td class="px-3 py-2.5">
                            <span class="badge badge-inactive font-mono text-xs">{{ entry.key }}</span>
                        </td>
                        <td class="px-3 py-2.5 text-right font-mono font-semibold" style="color: var(--color-primary)">
                            {{ Number(entry.total).toLocaleString("en-US") }}
                        </td>
                        <td class="px-3 py-2.5 text-right text-xs" style="color: var(--color-text-muted)">
                            {{ new Date(entry.updatedAt).toLocaleDateString("en-US") }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>
