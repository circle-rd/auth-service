<script setup lang="ts">
    import { computed } from "vue";
    import { useRoute, RouterLink } from "vue-router";
    import { useI18n } from "vue-i18n";
    import { ArrowLeft } from "lucide-vue-next";
    import AppRolesTab from "../../components/admin/AppRolesTab.vue";

    const { t } = useI18n();
    const route = useRoute();
    const appId = computed(() => route.params.id as string);
</script>

<template>
    <div class="space-y-6">
        <div class="flex items-center gap-3">
            <RouterLink :to="`/admin/applications/${appId}`" class="btn btn-ghost p-2 shrink-0"
                :title="t('common.back')">
                <ArrowLeft class="w-4 h-4" />
            </RouterLink>
            <h1 class="text-xl font-bold gradient-text">{{ t("admin.roles") }}</h1>
        </div>
        <AppRolesTab :app-id="appId" />
    </div>
</template>
