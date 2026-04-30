import { ref, computed } from 'vue';

export function usePagination(defaultLimit = 20) {
  const page = ref(1);
  const limit = ref(defaultLimit);
  const total = ref(0);

  const totalPages = computed(() => Math.ceil(total.value / limit.value));
  const hasPrev = computed(() => page.value > 1);
  const hasNext = computed(() => page.value < totalPages.value);

  function setTotal(n: number) {
    total.value = n;
  }

  function goTo(p: number) {
    page.value = Math.max(1, Math.min(p, totalPages.value || 1));
  }

  function prev() {
    if (hasPrev.value) page.value--;
  }

  function next() {
    if (hasNext.value) page.value++;
  }

  function reset() {
    page.value = 1;
    total.value = 0;
  }

  return { page, limit, total, totalPages, hasPrev, hasNext, setTotal, goTo, prev, next, reset };
}
