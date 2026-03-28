<script setup lang="ts">
  import { RouterView, useRoute } from "vue-router";
  import AppNav from "./components/AppNav.vue";
  import { useAuthStore } from "./stores/auth.js";
  import { computed, onMounted } from "vue";

  const authStore = useAuthStore();
  const route = useRoute();

  const showNav = computed(() => !route.path.startsWith("/admin"));

  onMounted(async () => {
    await authStore.fetchSession();
  });
</script>

<template>
  <AppNav v-if="showNav" />
  <RouterView />
</template>
