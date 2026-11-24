<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import { RESOURCE_SELF_SCOPE, type ApplicationFormState } from './state';
import { TEAMS_SCOPE, withManagedScope } from './scopes';

const props = defineProps<{
  form: ApplicationFormState;
  isEdit: boolean;
  litellmAvailable: boolean;
  resourceSharingAvailable: boolean;
}>();

const litellmSupport = defineModel<boolean>('litellm', { required: true });

// The user-resource scope is not a separate choice: it is what the Resource
// sharing option turns on, like the wallet scope behind LiteLLM support.
const resourceSharingSupport = computed({
  get: () => props.form.resourceSharingEnabled,
  set: (enabled: boolean) => {
    props.form.resourceSharingEnabled = enabled;
    props.form.allowedScopes = withManagedScope(props.form.allowedScopes, RESOURCE_SELF_SCOPE, enabled);
  },
});

const teamsSupport = computed({
  get: () => props.form.teamsEnabled,
  set: (enabled: boolean) => {
    props.form.teamsEnabled = enabled;
    props.form.allowedScopes = withManagedScope(props.form.allowedScopes, TEAMS_SCOPE, enabled);
  },
});

const { t } = useI18n();
</script>

<template>
  <div class="space-y-6">
    <section>
      <h4 class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
        {{ t('applications.optionsGroupAccess') }}
      </h4>
      <div class="rounded-lg border border-surface-700/50 divide-y divide-surface-800/60 bg-surface-800/20">
        <BaseToggle
          v-model="form.isActive"
          class="p-3.5"
          :label="t('applications.isActive')"
          :description="t('applications.isActiveHint')"
        />
        <BaseToggle
          v-model="form.isPublic"
          class="p-3.5"
          :label="t('applications.isPublic')"
          :description="t('applications.isPublicHint')"
          :disabled="isEdit"
        />
      </div>
    </section>

    <section>
      <h4 class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
        {{ t('applications.optionsGroupSignIn') }}
      </h4>
      <div class="rounded-lg border border-surface-700/50 divide-y divide-surface-800/60 bg-surface-800/20">
        <BaseToggle
          v-model="form.allowRegister"
          class="p-3.5"
          :label="t('applications.allowRegister')"
          :description="t('applications.allowRegisterHint')"
        />
        <BaseToggle
          v-model="form.isMfaRequired"
          class="p-3.5"
          :label="t('applications.isMfaRequired')"
          :description="t('applications.isMfaRequiredHint')"
        />
        <BaseToggle
          v-model="form.skipConsent"
          class="p-3.5"
          :label="t('applications.skipConsent')"
          :description="t('applications.skipConsentHint')"
        />
      </div>
    </section>

    <section>
      <h4 class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
        {{ t('applications.optionsGroupBilling') }}
      </h4>
      <div class="rounded-lg border border-surface-700/50 divide-y divide-surface-800/60 bg-surface-800/20">
        <BaseToggle
          v-model="form.billingDelegated"
          class="p-3.5"
          :label="t('applications.billingDelegated')"
          :description="t('applications.billingDelegatedHint')"
        />
      </div>
    </section>

    <section>
      <h4 class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
        {{ t('applications.optionsGroupSessions') }}
      </h4>
      <div class="rounded-lg border border-surface-700/50 divide-y divide-surface-800/60 bg-surface-800/20">
        <BaseToggle
          v-model="form.enableEndSession"
          class="p-3.5"
          :label="t('applications.enableEndSession')"
          :description="t('applications.enableEndSessionHint')"
        />
        <BaseToggle
          v-model="litellmSupport"
          class="p-3.5"
          :label="t('applications.litellmSupport')"
          :description="litellmAvailable ? t('applications.litellmSupportHint') : t('applications.litellmUnavailable')"
          :disabled="!litellmAvailable"
        />
        <BaseToggle
          v-model="resourceSharingSupport"
          class="p-3.5"
          :label="t('applications.resourceSharing')"
          :description="resourceSharingAvailable ? t('applications.resourceSharingHint') : t('applications.resourceSharingUnavailable')"
          :disabled="!resourceSharingAvailable"
        />
        <BaseToggle
          v-model="teamsSupport"
          class="p-3.5"
          :label="t('applications.teams')"
          :description="t('applications.teamsHint')"
        />
      </div>
    </section>
  </div>
</template>
