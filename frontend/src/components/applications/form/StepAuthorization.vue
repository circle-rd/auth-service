<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import StringListField from './StringListField.vue';
import { SCOPE_GROUPS, selectableScopes } from './scopes';
import type { ApplicationFormState } from './state';

const props = defineProps<{
  form: ApplicationFormState;
  hiddenResources: string[];
}>();

const { t } = useI18n();

function toggleScope(scope: string) {
  const scopes = props.form.allowedScopes;
  props.form.allowedScopes = scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope];
}
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

    <StringListField
      v-model="form.redirectUris"
      :label="t('applications.redirectUris')"
      :add-label="t('applications.addRedirectUri')"
      placeholder="https://your-app.com/callback"
    />

    <!-- Consulted only when RP-Initiated Logout is on; matched as plain string equality. -->
    <StringListField
      v-if="form.enableEndSession"
      v-model="form.postLogoutRedirectUris"
      :label="t('applications.postLogoutRedirectUris')"
      :add-label="t('applications.addPostLogoutRedirectUri')"
      :hint="t('applications.postLogoutRedirectUrisHint')"
      placeholder="https://your-app.com/"
    />

    <!-- Other applications (e.g. the LLM gateway) this one may request tokens for, via RFC 8707 `resource`. -->
    <StringListField
      v-model="form.allowedResources"
      :label="t('applications.allowedResources')"
      :add-label="t('applications.addAllowedResource')"
      :hint="t('applications.allowedResourcesHint')"
      placeholder="https://llm.your-domain.com"
      :hidden="hiddenResources"
    />
  </div>
</template>
