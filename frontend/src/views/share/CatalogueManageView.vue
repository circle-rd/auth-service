<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useCatalogueStore } from '@/stores/catalogue';
import ShareWorkspace from './ShareWorkspace.vue';

const route = useRoute();
const router = useRouter();
const store = useCatalogueStore();

const appId = computed(() => String(route.params.appId));
const app = computed(() => store.byId.get(appId.value) ?? null);

// Management is reserved to application administrators and delegates.
watch(
  app,
  (current) => {
    if (current && !current.owner) {
      void router.replace({ name: 'catalogue-dashboard', params: { appId: appId.value } });
    }
  },
  { immediate: true },
);
</script>

<template>
  <ShareWorkspace v-if="app?.owner" :app-id="app.id" />
</template>
