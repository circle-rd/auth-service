<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import {
  isMetadataKeyValid,
  metadataDuplicateKeys,
  type ApplicationFormState,
  type ProviderKey,
} from './state';

const props = defineProps<{
  form: ApplicationFormState;
  availableProviders: ProviderKey[];
}>();

const { t } = useI18n();

const inputClass =
  'px-3 py-2 text-sm bg-surface-800/80 border rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all';

const duplicateKeys = computed(() => metadataDuplicateKeys(props.form.metadata));

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

function addMetadataEntry() {
  props.form.metadata.push({ key: '', value: '' });
}

function removeMetadataEntry(i: number) {
  props.form.metadata.splice(i, 1);
}
</script>

<template>
  <div class="space-y-6">
    <!--
      OIDC Back-Channel Logout 1.0: when a session ends, AuthService POSTs a
      signed logout token to this endpoint. Must be an https URL.
    -->
    <div>
      <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
        {{ t('applications.backchannelLogoutUri') }}
      </p>
      <input
        v-model="form.backchannelLogoutUri"
        placeholder="https://your-app.com/backchannel-logout"
        :class="[inputClass, 'w-full border-surface-700/60']"
      />
      <p class="text-xs text-surface-500 mt-2">{{ t('applications.backchannelLogoutUriHint') }}</p>
      <div v-if="form.backchannelLogoutUri" class="mt-2">
        <BaseToggle
          v-model="form.backchannelLogoutSessionRequired"
          :label="t('applications.backchannelLogoutSessionRequired')"
          :description="t('applications.backchannelLogoutSessionRequiredHint')"
        />
      </div>
    </div>

    <div v-if="availableProviders.length > 0">
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
      <p class="text-xs text-surface-500 mb-2">
        {{
          form.enabledSocialProviders === null
            ? t('applications.providersInherited')
            : t('applications.providersOverridden')
        }}
      </p>
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
    </div>

    <!--
      Metadata: key/value pairs injected into JWTs under `client_attrs`, used by
      resource servers such as EMQX (ACL via `${client_attrs.NAME}`).
      Keys must be valid identifiers (server-enforced), values are strings.
    -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
          {{ t('applications.metadata') }}
        </p>
        <button
          type="button"
          @click="addMetadataEntry"
          class="text-xs text-primary-400 hover:text-primary-300 transition-colors font-medium"
        >
          + {{ t('applications.addMetadataEntry') }}
        </button>
      </div>
      <p class="text-xs text-surface-500 mb-2">{{ t('applications.metadataDescription') }}</p>
      <div v-if="form.metadata.length === 0" class="text-xs text-surface-600 italic py-1">
        {{ t('applications.metadataEmpty') }}
      </div>
      <div v-else class="space-y-2">
        <div v-for="(entry, i) in form.metadata" :key="i" class="flex gap-2">
          <input
            v-model="entry.key"
            :placeholder="t('applications.metadataKeyPlaceholder')"
            :class="[
              inputClass,
              'w-1/3 font-mono',
              isMetadataKeyValid(entry.key) && !duplicateKeys.has(entry.key)
                ? 'border-surface-700/60'
                : 'border-red-500/60',
            ]"
          />
          <input
            v-model="entry.value"
            :placeholder="t('applications.metadataValuePlaceholder')"
            :class="[inputClass, 'flex-1 border-surface-700/60']"
          />
          <button
            type="button"
            @click="removeMetadataEntry(i)"
            class="px-2 text-surface-600 hover:text-red-400 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>
      </div>
      <p v-if="duplicateKeys.size > 0" class="text-xs text-red-400 mt-2">
        {{ t('applications.metadataDuplicateKey') }}
      </p>
    </div>
  </div>
</template>
