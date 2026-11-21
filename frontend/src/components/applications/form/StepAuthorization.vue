<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import { SCOPE_GROUPS, selectableScopes } from './scopes';
import type { ApplicationFormState, ProviderKey } from './state';

const props = defineProps<{
  form: ApplicationFormState;
  availableProviders: ProviderKey[];
}>();

const { t } = useI18n();

function toggleScope(scope: string) {
  const scopes = props.form.allowedScopes;
  props.form.allowedScopes = scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope];
}

function isProviderSelected(p: ProviderKey): boolean {
  // null = inherit, i.e. every globally enabled provider is on.
  return props.form.enabledSocialProviders === null || props.form.enabledSocialProviders.includes(p);
}

function toggleProvider(p: ProviderKey) {
  const current = props.form.enabledSocialProviders;
  if (current === null) {
    // First toggle materializes the inherited list.
    props.form.enabledSocialProviders = props.availableProviders.filter((x) => x !== p);
    return;
  }
  props.form.enabledSocialProviders = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
}

const providersHint = computed(() =>
  props.form.enabledSocialProviders === null
    ? t('applications.providersInherited')
    : t('applications.providersOverridden'),
);
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-4">
      <div>
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
          {{ t('applications.allowedScopes') }}
        </p>
        <p class="text-xs text-surface-500 mt-1">{{ t('applications.scopesHint') }}</p>
      </div>
      <section v-for="group in SCOPE_GROUPS" :key="group">
        <h4 class="text-xs font-medium text-surface-400 mb-2">
          {{ t(`applications.scopeGroups.${group}`) }}
        </h4>
        <div class="rounded-lg border border-surface-700/50 divide-y divide-surface-800/60 bg-surface-800/20">
          <BaseToggle
            v-for="info in selectableScopes(group)"
            :key="info.scope"
            class="p-3.5"
            mono
            :model-value="form.allowedScopes.includes(info.scope)"
            :label="info.scope"
            :description="t(`applications.scopeHints.${info.scope}`)"
            @update:model-value="toggleScope(info.scope)"
          />
        </div>
      </section>
    </div>

    <!-- Which identity providers this application offers at sign-in. -->
    <section v-if="availableProviders.length > 0">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
          {{ t('applications.socialProviders') }}
        </p>
        <button
          v-if="form.enabledSocialProviders !== null"
          type="button"
          @click="form.enabledSocialProviders = null"
          class="text-xs text-primary-400 hover:text-primary-300 font-medium"
        >
          {{ t('applications.inheritProviders') }}
        </button>
      </div>
      <p class="text-xs text-surface-500 mb-2">{{ providersHint }}</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="p in availableProviders"
          :key="p"
          type="button"
          @click="toggleProvider(p)"
          :class="[
            'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors capitalize',
            isProviderSelected(p)
              ? 'bg-primary-600/20 border-primary-500/40 text-primary-300'
              : 'bg-surface-800/60 border-surface-700/60 text-surface-500 hover:border-surface-500 hover:text-surface-300',
          ]"
        >
          {{ p }}
        </button>
      </div>
    </section>
  </div>
</template>
