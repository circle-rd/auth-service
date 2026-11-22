import { inject, provide, ref, type InjectionKey, type Ref } from 'vue';

const CATALOGUE_ACTIVITY: InjectionKey<Ref<number>> = Symbol('catalogue-activity');

/**
 * One SSE subscription lives in the catalogue shell. Activity panels watch this
 * tick instead of opening their own EventSource or polling.
 */
export function provideCatalogueActivity(): Ref<number> {
  const tick = ref(0);
  provide(CATALOGUE_ACTIVITY, tick);
  return tick;
}

export function useCatalogueActivityTick(): Ref<number> | null {
  return inject(CATALOGUE_ACTIVITY, null);
}
