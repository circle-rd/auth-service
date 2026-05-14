<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { createApplication, updateApplication } from '@/api/applications';
import { getServicesConfig } from '@/api/services';
import type { Application, ServicesConfig } from '@/types';
import { useToast } from '@/composables/useToast';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import EntityModal from '@/components/ui/EntityModal.vue';

const props = defineProps<{
  open: boolean;
  application?: Application | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [app: Application, clientSecret?: string];
}>();

const { t } = useI18n();
const toast = useToast();
const loading = ref(false);
const services = ref<ServicesConfig | null>(null);

const isEdit = computed(() => !!props.application);

const SCOPES = ['openid', 'profile', 'email', 'phone', 'offline_access', 'roles', 'permissions', 'features', 'org'];
const ALL_PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;
type ProviderKey = (typeof ALL_PROVIDERS)[number];

const form = ref({
  name: '',
  slug: '',
  description: '',
  url: '',
  icon: '',
  isActive: true,
  isPublic: false,
  skipConsent: false,
  isMfaRequired: false,
  allowRegister: true,
  allowedScopes: ['openid', 'profile', 'email', 'roles', 'permissions', 'features'] as string[],
  redirectUris: [''] as string[],
  enabledSocialProviders: null as string[] | null,
  // OIDC RP-Initiated Logout (1.0). Off by default — only opt in if the
  // application actually needs to terminate the central SSO session.
  enableEndSession: false,
  postLogoutRedirectUris: [] as string[],
  // Metadata is edited as an ordered list of key/value pairs in the UI;
  // we serialize back to a plain Record<string, string> on submit. Keys must
  // be valid identifiers (server enforces /^[a-zA-Z_][a-zA-Z0-9_]*$/) and
  // both keys/values are strings (EMQX `client_attrs` contract).
  metadata: [] as Array<{ key: string; value: string }>,
});

// Validate identifier-style keys client-side (server enforces too).
const METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Track the last auto-generated redirect URI to detect manual overrides
const lastAutoRedirectUri = ref('');

watch(
  () => form.value.name,
  (name) => {
    if (!isEdit.value) form.value.slug = slugify(name);
  },
);

watch(
  () => form.value.url,
  (url) => {
    if (isEdit.value) return;
    const candidate = url ? url.replace(/\/$/, '') + '/callback' : '';
    if (form.value.redirectUris[0] === '' || form.value.redirectUris[0] === lastAutoRedirectUri.value) {
      form.value.redirectUris[0] = candidate;
      lastAutoRedirectUri.value = candidate;
    }
  },
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    if (!services.value) {
      try {
        services.value = await getServicesConfig();
      } catch {
        services.value = null;
      }
    }
    const a = props.application;
    if (a) {
      form.value = {
        name: a.name,
        slug: a.slug,
        description: a.description ?? '',
        url: a.url ?? '',
        icon: a.icon ?? '',
        isActive: a.isActive,
        isPublic: a.isPublic,
        skipConsent: a.skipConsent,
        isMfaRequired: a.isMfaRequired,
        allowRegister: a.allowRegister,
        allowedScopes: [...a.allowedScopes],
        redirectUris: a.redirectUris.length ? [...a.redirectUris] : [''],
        enabledSocialProviders: a.enabledSocialProviders
          ? [...a.enabledSocialProviders]
          : null,
        enableEndSession: a.enableEndSession ?? false,
        postLogoutRedirectUris: a.postLogoutRedirectUris
          ? [...a.postLogoutRedirectUris]
          : [],
        metadata: Object.entries(a.metadata ?? {}).map(([key, value]) => ({
          key,
          value: String(value),
        })),
      };
    } else {
      lastAutoRedirectUri.value = '';
      form.value = {
        name: '',
        slug: '',
        description: '',
        url: '',
        icon: '',
        isActive: true,
        isPublic: false,
        skipConsent: false,
        isMfaRequired: false,
        allowRegister: true,
        allowedScopes: ['openid', 'profile', 'email', 'roles', 'permissions', 'features'],
        redirectUris: [''],
        enabledSocialProviders: null,
        enableEndSession: false,
        postLogoutRedirectUris: [],
        metadata: [],
      };
    }
  },
  { immediate: true },
);

const tags = computed(() => {
  const out: Array<{ label: string; variant: 'success' | 'neutral' | 'warning' | 'info' }> = [];
  out.push({
    label: form.value.isActive ? t('common.active') : t('common.inactive'),
    variant: form.value.isActive ? 'success' : 'neutral',
  });
  out.push({
    label: form.value.isPublic ? t('applications.public') : t('applications.confidential'),
    variant: form.value.isPublic ? 'info' : 'neutral',
  });
  if (form.value.isMfaRequired) out.push({ label: 'MFA', variant: 'warning' });
  if (form.value.skipConsent) out.push({ label: t('applications.skipConsent'), variant: 'neutral' });
  return out;
});

const enabledProvidersGlobally = computed<ProviderKey[]>(() => {
  if (!services.value) return [];
  return ALL_PROVIDERS.filter((p) => services.value!.providers[p]?.enabled);
});

function toggleScope(scope: string) {
  const i = form.value.allowedScopes.indexOf(scope);
  if (i >= 0) form.value.allowedScopes.splice(i, 1);
  else form.value.allowedScopes.push(scope);
}

function isProviderSelected(p: ProviderKey): boolean {
  // null = inherit (treat as "all globally enabled selected")
  if (form.value.enabledSocialProviders === null) return true;
  return form.value.enabledSocialProviders.includes(p);
}

function toggleProvider(p: ProviderKey) {
  // Materialize from null to a concrete list on first toggle
  if (form.value.enabledSocialProviders === null) {
    form.value.enabledSocialProviders = enabledProvidersGlobally.value.filter((x) => x !== p);
    return;
  }
  const idx = form.value.enabledSocialProviders.indexOf(p);
  if (idx >= 0) form.value.enabledSocialProviders.splice(idx, 1);
  else form.value.enabledSocialProviders.push(p);
}

function inheritProviders() {
  form.value.enabledSocialProviders = null;
}

function addRedirectUri() {
  form.value.redirectUris.push('');
}
function removeRedirectUri(i: number) {
  form.value.redirectUris.splice(i, 1);
}

function addPostLogoutRedirectUri() {
  form.value.postLogoutRedirectUris.push('');
}
function removePostLogoutRedirectUri(i: number) {
  form.value.postLogoutRedirectUris.splice(i, 1);
}

function addMetadataEntry() {
  form.value.metadata.push({ key: '', value: '' });
}
function removeMetadataEntry(i: number) {
  form.value.metadata.splice(i, 1);
}
function isMetadataKeyValid(key: string): boolean {
  return key === '' || METADATA_KEY_RE.test(key);
}
const metadataDuplicateKeys = computed<Set<string>>(() => {
  const seen = new Map<string, number>();
  for (const { key } of form.value.metadata) {
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
});
const metadataHasError = computed(() => {
  if (metadataDuplicateKeys.value.size > 0) return true;
  return form.value.metadata.some(
    ({ key, value }) =>
      // Empty rows are silently dropped on submit, but a row with only one
      // side filled is an error.
      (key === '' && value !== '') || (key !== '' && !METADATA_KEY_RE.test(key)),
  );
});

async function submit() {
  if (!form.value.name) return;
  if (!isEdit.value && !form.value.slug) return;
  if (metadataHasError.value) {
    toast.error(t('applications.metadataInvalid'));
    return;
  }
  // Drop empty rows; collapse to a plain Record<string, string>.
  const metadata: Record<string, string> = {};
  for (const { key, value } of form.value.metadata) {
    if (!key) continue;
    metadata[key] = value;
  }
  loading.value = true;
  try {
    const body = {
      name: form.value.name,
      description: form.value.description || undefined,
      url: form.value.url || undefined,
      icon: form.value.icon || undefined,
      isActive: form.value.isActive,
      skipConsent: form.value.skipConsent,
      isMfaRequired: form.value.isMfaRequired,
      allowRegister: form.value.allowRegister,
      allowedScopes: form.value.allowedScopes,
      redirectUris: form.value.redirectUris.filter(Boolean),
      enabledSocialProviders: form.value.enabledSocialProviders,
      enableEndSession: form.value.enableEndSession,
      postLogoutRedirectUris: form.value.postLogoutRedirectUris.filter(Boolean),
      metadata,
    };
    if (isEdit.value && props.application) {
      const res = await updateApplication(props.application.id, body);
      toast.success(t('applications.updated'));
      emit('saved', res.application);
    } else {
      const res = await createApplication({
        ...body,
        slug: form.value.slug,
        isPublic: form.value.isPublic,
      });
      emit('saved', res.application, res.clientSecret);
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('applications.saveFailed'));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <EntityModal
    :open="open"
    :name="form.name || (isEdit ? t('applications.editApp') : t('applications.createApp'))"
    :subtitle="form.slug || 'app-slug'"
    :icon-url="form.icon || null"
    :icon-letter="form.name ? form.name[0].toUpperCase() : 'A'"
    icon-shape="square"
    :tags="tags"
    size="xl"
    @close="emit('close')"
  >
    <form @submit.prevent="submit" class="space-y-5">
      <div class="grid grid-cols-2 gap-4">
        <BaseInput v-model="form.name" :label="t('applications.name')" required />
        <BaseInput
          v-model="form.slug"
          :label="t('applications.slug')"
          :disabled="isEdit"
          required
        />
      </div>
      <BaseInput v-model="form.description" :label="t('applications.description')" />
      <div class="grid grid-cols-2 gap-4">
        <BaseInput v-model="form.url" :label="t('applications.url')" placeholder="https://app.example.com" />
        <BaseInput v-model="form.icon" :label="t('applications.icon')" placeholder="https://..." />
      </div>

      <div class="pt-1">
        <p class="text-xs font-medium text-surface-500 uppercase tracking-wider mb-3">Options</p>
        <div class="grid grid-cols-2 gap-x-8 gap-y-3">
          <BaseToggle v-model="form.isActive" :label="t('applications.isActive')" />
          <BaseToggle
            v-model="form.isPublic"
            :label="t('applications.isPublic')"
            description="PKCE only, no secret"
            :disabled="isEdit"
          />
          <BaseToggle v-model="form.skipConsent" :label="t('applications.skipConsent')" />
          <BaseToggle v-model="form.isMfaRequired" :label="t('applications.isMfaRequired')" />
          <BaseToggle v-model="form.allowRegister" :label="t('applications.allowRegister')" />
          <BaseToggle
            v-model="form.enableEndSession"
            :label="t('applications.enableEndSession')"
            :description="t('applications.enableEndSessionHint')"
          />
        </div>
      </div>

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

      <div v-if="enabledProvidersGlobally.length > 0">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
            {{ t('applications.socialProviders') }}
          </p>
          <button
            v-if="form.enabledSocialProviders !== null"
            type="button"
            @click="inheritProviders"
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
            v-for="p in enabledProvidersGlobally"
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

      <div>
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
            {{ t('applications.redirectUris') }}
          </p>
          <button
            type="button"
            @click="addRedirectUri"
            class="text-xs text-primary-400 hover:text-primary-300 transition-colors font-medium"
          >
            + {{ t('applications.addRedirectUri') }}
          </button>
        </div>
        <div class="space-y-2">
          <div v-for="(_, i) in form.redirectUris" :key="i" class="flex gap-2">
            <input
              v-model="form.redirectUris[i]"
              placeholder="https://your-app.com/callback"
              class="flex-1 px-3 py-2 text-sm bg-surface-800/80 border border-surface-700/60 rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all"
            />
            <button
              type="button"
              @click="removeRedirectUri(i)"
              class="px-2 text-surface-600 hover:text-red-400 transition-colors text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      <!--
        Post-logout redirect URIs: whitelist for OIDC RP-Initiated Logout.
        Only consulted when `enableEndSession` is on. AuthService matches the
        incoming `post_logout_redirect_uri` against this list as plain string
        equality — query strings included.
      -->
      <div v-if="form.enableEndSession">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">
            {{ t('applications.postLogoutRedirectUris') }}
          </p>
          <button
            type="button"
            @click="addPostLogoutRedirectUri"
            class="text-xs text-primary-400 hover:text-primary-300 transition-colors font-medium"
          >
            + {{ t('applications.addPostLogoutRedirectUri') }}
          </button>
        </div>
        <p class="text-xs text-surface-500 mb-2">
          {{ t('applications.postLogoutRedirectUrisHint') }}
        </p>
        <div class="space-y-2">
          <div
            v-for="(_, i) in form.postLogoutRedirectUris"
            :key="i"
            class="flex gap-2"
          >
            <input
              v-model="form.postLogoutRedirectUris[i]"
              placeholder="https://your-app.com/"
              class="flex-1 px-3 py-2 text-sm bg-surface-800/80 border border-surface-700/60 rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all"
            />
            <button
              type="button"
              @click="removePostLogoutRedirectUri(i)"
              class="px-2 text-surface-600 hover:text-red-400 transition-colors text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      <!--
        Metadata: per-application key/value pairs that AuthService injects
        into JWTs under the `client_attrs` field. Used by resource servers
        such as EMQX (ACL via `${client_attrs.NAME}` placeholders).
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
        <p class="text-xs text-surface-500 mb-2">
          {{ t('applications.metadataDescription') }}
        </p>
        <div v-if="form.metadata.length === 0" class="text-xs text-surface-600 italic py-1">
          {{ t('applications.metadataEmpty') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="(entry, i) in form.metadata"
            :key="i"
            class="flex gap-2"
          >
            <input
              v-model="entry.key"
              :placeholder="t('applications.metadataKeyPlaceholder')"
              :class="[
                'w-1/3 px-3 py-2 text-sm bg-surface-800/80 border rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all font-mono',
                isMetadataKeyValid(entry.key) && !metadataDuplicateKeys.has(entry.key)
                  ? 'border-surface-700/60'
                  : 'border-red-500/60',
              ]"
            />
            <input
              v-model="entry.value"
              :placeholder="t('applications.metadataValuePlaceholder')"
              class="flex-1 px-3 py-2 text-sm bg-surface-800/80 border border-surface-700/60 rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all"
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
        <p
          v-if="metadataDuplicateKeys.size > 0"
          class="text-xs text-red-400 mt-2"
        >
          {{ t('applications.metadataDuplicateKey') }}
        </p>
      </div>
    </form>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="loading" @click="submit">
        {{ isEdit ? t('common.save') : t('common.create') }}
      </BaseButton>
    </template>
  </EntityModal>
</template>
