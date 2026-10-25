<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import StringListField from './StringListField.vue';
import { SCOPES, type ApplicationFormState } from './state';

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
    <div>
      <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
        {{ t('applications.allowedScopes') }}
      </p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="scope in SCOPES"
          :key="scope"
          type="button"
          @click="toggleScope(scope)"
          :class="[
            'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
            form.allowedScopes.includes(scope)
              ? 'bg-primary-600/20 border-primary-500/40 text-primary-300'
              : 'bg-surface-800/60 border-surface-700/60 text-surface-500 hover:border-surface-500 hover:text-surface-300',
          ]"
        >
          {{ scope }}
        </button>
      </div>
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
