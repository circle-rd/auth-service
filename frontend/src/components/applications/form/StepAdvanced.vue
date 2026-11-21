<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import StringListField from './StringListField.vue';
import {
  isMetadataKeyValid,
  metadataDuplicateKeys,
  type ApplicationFormState,
} from './state';

const props = defineProps<{
  form: ApplicationFormState;
  webhookSecret: string | null;
  isSystem: boolean;
  hiddenResources: string[];
}>();

const { t } = useI18n();

const inputClass =
  'px-3 py-2 text-sm bg-surface-800/80 border rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all';

const duplicateKeys = computed(() => metadataDuplicateKeys(props.form.metadata));

function addMetadataEntry() {
  props.form.metadata.push({ key: '', value: '' });
}

function removeMetadataEntry(i: number) {
  props.form.metadata.splice(i, 1);
}

// ── URI generator ─────────────────────────────────────────────────────────
// Most applications expose every identity endpoint under one API prefix. The
// path below only fills the fields: each URI stays editable for applications
// whose routes do not follow that convention.
const callbackPath = ref('');

const baseUrl = computed(() => props.form.url.trim().replace(/\/+$/, ''));
const prefix = computed(() => {
  const path = callbackPath.value.trim().replace(/^\/+|\/+$/g, '');
  return path ? `/${path}` : '';
});
const derivedBase = computed(() => (baseUrl.value ? `${baseUrl.value}${prefix.value}` : ''));

onMounted(() => {
  // Recover the prefix from an existing redirect URI so editing an application
  // does not force the operator to retype it.
  const first = props.form.redirectUris.find((uri) => !!uri);
  const base = baseUrl.value;
  if (!first || !base || !first.startsWith(`${base}/`)) return;
  const match = first.slice(base.length).match(/^(.*)\/callback(?:\?.*)?$/);
  if (match?.[1]) callbackPath.value = match[1];
});

interface DerivedUri {
  key: 'authorization' | 'postLogout' | 'backchannel' | 'resourceEvents';
  label: string;
  value: string;
}

const derivedUris = computed<DerivedUri[]>(() => {
  if (!derivedBase.value) return [];
  const base = derivedBase.value;
  const rows: DerivedUri[] = [
    {
      key: 'authorization',
      label: t('applications.derivedUriAuthorization'),
      value: `${base}/callback`,
    },
    {
      key: 'backchannel',
      label: t('applications.derivedUriBackchannel'),
      value: `${base}/backchannel-logout`,
    },
    {
      key: 'resourceEvents',
      label: t('applications.derivedUriResourceEvents'),
      value: `${base}/resources/events`,
    },
  ];
  if (props.form.enableEndSession) {
    rows.splice(1, 0, {
      key: 'postLogout',
      label: t('applications.derivedUriPostLogout'),
      value: `${base}/logout`,
    });
  }
  return rows;
});

function useDerived(key: DerivedUri['key']) {
  const value = derivedUris.value.find((row) => row.key === key)?.value;
  if (!value) return;
  const form = props.form;
  if (key === 'authorization') {
    if (!form.redirectUris.includes(value)) form.redirectUris = [...form.redirectUris.filter(Boolean), value];
  } else if (key === 'postLogout') {
    if (!form.postLogoutRedirectUris.includes(value)) {
      form.postLogoutRedirectUris = [...form.postLogoutRedirectUris.filter(Boolean), value];
    }
  } else if (key === 'backchannel') {
    form.backchannelLogoutUri = value;
  } else {
    form.resourceWebhookUrl = value;
  }
}

function useAllDerived() {
  for (const row of derivedUris.value) useDerived(row.key);
}

const tokenAuthOptions = computed(() => [
  { value: 'client_secret_basic', label: t('applications.tokenAuthBasic') },
  { value: 'client_secret_post', label: t('applications.tokenAuthPost') },
]);

function setTokenAuthMethod(value: string) {
  props.form.tokenEndpointAuthMethod =
    value === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic';
}
</script>

<template>
  <div class="space-y-6">
    <!-- ── URIs ─────────────────────────────────────────────────────────── -->
    <section class="space-y-4">
      <div>
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
          {{ t('applications.urisGroup') }}
        </p>
        <p class="text-xs text-surface-500 mt-1">{{ t('applications.urisGroupHint') }}</p>
      </div>

      <div class="rounded-lg border border-surface-700/50 bg-surface-800/20 p-3.5 space-y-3">
        <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
          <div>
            <label class="text-xs font-medium text-surface-500 block mb-1.5">
              {{ t('applications.baseUrl') }}
            </label>
            <input
              :value="baseUrl"
              readonly
              :placeholder="t('applications.baseUrlMissing')"
              :class="[inputClass, 'w-full border-surface-700/60 text-surface-400']"
            />
            <p v-if="!baseUrl" class="text-xs text-amber-400 mt-1.5">
              {{ t('applications.baseUrlMissingHint') }}
            </p>
          </div>
          <div>
            <label class="text-xs font-medium text-surface-500 block mb-1.5">
              {{ t('applications.callbackBasePath') }}
            </label>
            <input
              v-model="callbackPath"
              placeholder="/auth"
              :class="[inputClass, 'w-full border-surface-700/60 font-mono']"
            />
          </div>
        </div>
        <p class="text-xs text-surface-500">{{ t('applications.callbackBasePathHint') }}</p>

        <div v-if="derivedUris.length > 0" class="space-y-2">
          <div
            v-for="row in derivedUris"
            :key="row.key"
            class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between rounded-md bg-surface-900/50 border border-surface-700/40 px-3 py-2"
          >
            <div class="min-w-0">
              <p class="text-[11px] text-surface-500">{{ row.label }}</p>
              <code class="text-xs text-surface-200 break-all">{{ row.value }}</code>
            </div>
            <button
              type="button"
              class="shrink-0 text-xs font-medium text-primary-400 hover:text-primary-300"
              @click="useDerived(row.key)"
            >
              {{ t('applications.useDerivedUri') }}
            </button>
          </div>
          <button
            type="button"
            class="text-xs font-medium text-primary-400 hover:text-primary-300"
            @click="useAllDerived"
          >
            {{ t('applications.useAllDerivedUris') }}
          </button>
        </div>
      </div>

      <StringListField
        v-model="form.redirectUris"
        :label="t('applications.redirectUris')"
        :add-label="t('applications.addRedirectUri')"
        placeholder="https://your-app.com/auth/callback"
      />

      <!-- Consulted only when RP-Initiated Logout is on; matched as plain string equality. -->
      <StringListField
        v-if="form.enableEndSession"
        v-model="form.postLogoutRedirectUris"
        :label="t('applications.postLogoutRedirectUris')"
        :add-label="t('applications.addPostLogoutRedirectUri')"
        :hint="t('applications.postLogoutRedirectUrisHint')"
        placeholder="https://your-app.com/auth/logout"
      />

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
          placeholder="https://your-app.com/auth/backchannel-logout"
          :class="[inputClass, 'w-full border-surface-700/60']"
        />
        <p class="text-xs text-surface-500 mt-2">{{ t('applications.backchannelLogoutUriHint') }}</p>
      </div>

      <!--
        Resource-sharing webhook: signed POSTs about grants so the application
        can update dashboards without polling.
      -->
      <div>
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
          {{ t('applications.resourceWebhookUrl') }}
        </p>
        <input
          v-model="form.resourceWebhookUrl"
          placeholder="https://your-app.com/auth/resources/events"
          :class="[inputClass, 'w-full border-surface-700/60']"
        />
        <p class="text-xs text-surface-500 mt-2">{{ t('applications.resourceWebhookUrlHint') }}</p>
        <div v-if="webhookSecret" class="mt-3">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-2">
            {{ t('applications.resourceWebhookSecret') }}
          </p>
          <code class="block px-3 py-2 text-xs bg-surface-800/80 border border-surface-700/60 rounded-md text-surface-200 break-all">{{ webhookSecret }}</code>
          <p class="text-xs text-surface-500 mt-2">{{ t('applications.resourceWebhookSecretHint') }}</p>
        </div>
      </div>
    </section>

    <!-- Confidential clients: PKCE requirement and token endpoint authentication. -->
    <section v-if="!form.isPublic && !isSystem" class="space-y-3">
      <div>
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
          {{ t('applications.optionsGroupOidcClient') }}
        </p>
        <p class="text-xs text-surface-500 mt-1">
          {{ t('applications.oauthClientHint') }}
        </p>
      </div>
      <div class="rounded-lg border border-surface-700/50 divide-y divide-surface-800/60 bg-surface-800/20">
        <BaseToggle
          v-model="form.requirePKCE"
          class="p-3.5"
          :label="t('applications.requirePKCE')"
          :description="t('applications.requirePKCEHint')"
        />
        <div class="p-3.5">
          <BaseSelect
            :model-value="form.tokenEndpointAuthMethod"
            :label="t('applications.tokenEndpointAuthMethod')"
            :options="tokenAuthOptions"
            @update:model-value="setTokenAuthMethod"
          />
          <p class="text-xs text-surface-500 mt-1.5">
            {{ t('applications.tokenEndpointAuthMethodHint') }}
          </p>
        </div>
      </div>
    </section>

    <!-- Other applications (e.g. the LLM gateway) this one may request tokens for, via RFC 8707 `resource`. -->
    <StringListField
      v-model="form.allowedResources"
      :label="t('applications.allowedResources')"
      :add-label="t('applications.addAllowedResource')"
      :hint="t('applications.allowedResourcesHint')"
      placeholder="https://llm.your-domain.com"
      :hidden="hiddenResources"
    />

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
