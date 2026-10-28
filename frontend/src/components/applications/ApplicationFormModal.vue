<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { createApplication, detectFavicon, listApplications, updateApplication } from '@/api/applications';
import { getServicesConfig } from '@/api/services';
import type { Application, ServicesConfig } from '@/types';
import { useToast } from '@/composables/useToast';
import BaseButton from '@/components/ui/BaseButton.vue';
import SplitModal from '@/components/ui/SplitModal.vue';
import StepGeneral from './form/StepGeneral.vue';
import StepOptions from './form/StepOptions.vue';
import StepAuthorization from './form/StepAuthorization.vue';
import StepAdvanced from './form/StepAdvanced.vue';
import { WALLET_SCOPE } from './form/scopes';
import {
  ALL_PROVIDERS,
  emptyApplicationForm,
  formFromApplication,
  metadataHasError,
  type ApplicationFormState,
  type ProviderKey,
} from './form/state';

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

const form = ref<ApplicationFormState>(emptyApplicationForm());

// ── Steps ────────────────────────────────────────────────────────────────
// Authorization and Advanced are optional: the application can be saved from
// the Authorization step on (from any step when editing).
const STEP_GENERAL = 0;
const STEP_OPTIONS = 1;
const STEP_AUTHORIZATION = 2;
const STEP_ADVANCED = 3;
const FIRST_SAVE_STEP = STEP_AUTHORIZATION;

const steps = computed(() => [
  { label: t('applications.sectionGeneral'), hint: t('applications.stepGeneralHint'), optional: false },
  { label: t('applications.sectionOptions'), hint: t('applications.stepOptionsHint'), optional: false },
  { label: t('applications.sectionAuthorization'), hint: t('applications.stepAuthorizationHint'), optional: true },
  { label: t('applications.sectionAdvanced'), hint: t('applications.stepAdvancedHint'), optional: true },
]);

const step = ref(STEP_GENERAL);
const isLastStep = computed(() => step.value === steps.value.length - 1);
const identityValid = computed(() => !!form.value.name && (isEdit.value || !!form.value.slug));
const showSave = computed(() => isEdit.value || step.value >= FIRST_SAVE_STEP);

function goTo(i: number) {
  // Later steps are reachable once the application has an identity.
  if (i > STEP_GENERAL && !identityValid.value) return;
  step.value = i;
}

function next() {
  if (!isLastStep.value) goTo(step.value + 1);
}

// ── LiteLLM support ──────────────────────────────────────────────────────
// One switch stands for three settings: the gateway and Auth Service resources,
// and the wallet scope. They live in the regular arrays so nothing is lost on
// save, but are hidden from the resource list and the scope chips.
const litellmUrls = ref<string[]>([]);
const litellmAvailable = computed(() => litellmUrls.value.length === 2);
const litellmEnabled = ref(false);

// System applications whose `url` is the resource identifier (RFC 8707) of the
// LLM gateway and of the Auth Service API.
const GATEWAY_SLUG = 'litellm';
const AUTH_SERVICE_SLUG = 'auth-service';

async function loadLitellmUrls() {
  try {
    const { applications } = await listApplications();
    const urls = [GATEWAY_SLUG, AUTH_SERVICE_SLUG].map(
      (slug) => applications.find((a) => a.slug === slug)?.url ?? null,
    );
    litellmUrls.value = urls.every((u): u is string => !!u) ? urls : [];
  } catch {
    litellmUrls.value = [];
  }
}

const litellmSupport = computed({
  get: () => litellmEnabled.value,
  set: (on: boolean) => {
    litellmEnabled.value = on;
    const f = form.value;
    if (on) {
      for (const url of litellmUrls.value) {
        if (!f.allowedResources.includes(url)) f.allowedResources.push(url);
      }
      if (!f.allowedScopes.includes(WALLET_SCOPE)) f.allowedScopes.push(WALLET_SCOPE);
    } else {
      f.allowedResources = f.allowedResources.filter((u) => !litellmUrls.value.includes(u));
      f.allowedScopes = f.allowedScopes.filter((sc) => sc !== WALLET_SCOPE);
    }
  },
});

// The LiteLLM resources are managed by the switch while it is on.
const hiddenResources = computed(() => (litellmEnabled.value ? litellmUrls.value : []));

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

// ── Icon detection ───────────────────────────────────────────────────────
// Once the URL is typed (a pause of FAVICON_DEBOUNCE_MS, or leaving the field)
// the page's favicon is looked up and offered as the icon. It never overwrites an
// icon the user typed: only an empty one, or the one detected for the previous URL.
const FAVICON_DEBOUNCE_MS = 600;
const lastAutoIcon = ref('');
let lastLookedUpUrl = '';
let faviconTimer: ReturnType<typeof setTimeout> | undefined;
let faviconRequest = 0;

const iconAutoDetected = computed(() => !!form.value.icon && form.value.icon === lastAutoIcon.value);

function iconIsUserOwned(): boolean {
  return !!form.value.icon && form.value.icon !== lastAutoIcon.value;
}

async function lookupFavicon() {
  clearTimeout(faviconTimer);
  const url = form.value.url.trim();
  if (!/^https?:\/\/[^\s/.]+\.[^\s/]+/i.test(url) || url === lastLookedUpUrl || iconIsUserOwned()) return;
  lastLookedUpUrl = url;
  const request = ++faviconRequest;
  let iconUrl: string | null = null;
  try {
    iconUrl = await detectFavicon(url);
  } catch {
    // Best effort: the icon stays editable by hand.
  }
  // A newer lookup started, or the user typed an icon while this one ran.
  if (request !== faviconRequest || iconIsUserOwned()) return;
  if (iconUrl) {
    form.value.icon = iconUrl;
    lastAutoIcon.value = iconUrl;
  } else if (lastAutoIcon.value) {
    // The new URL has no favicon: do not keep the previous site's.
    form.value.icon = '';
    lastAutoIcon.value = '';
  }
}

function onUrlInput() {
  clearTimeout(faviconTimer);
  faviconTimer = setTimeout(() => void lookupFavicon(), FAVICON_DEBOUNCE_MS);
}

onBeforeUnmount(() => clearTimeout(faviconTimer));

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    clearTimeout(faviconTimer);
    faviconRequest++;
    lastAutoIcon.value = '';
    lastLookedUpUrl = props.application?.url ?? '';
    step.value = STEP_GENERAL;
    const urlsLoaded = loadLitellmUrls();
    if (!services.value) {
      try {
        services.value = await getServicesConfig();
      } catch {
        services.value = null;
      }
    }
    await urlsLoaded;
    const a = props.application;
    litellmEnabled.value =
      !!a && litellmAvailable.value && (a.allowedResources ?? []).includes(litellmUrls.value[0]!);
    lastAutoRedirectUri.value = '';
    form.value = a ? formFromApplication(a) : emptyApplicationForm();
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

const availableProviders = computed<ProviderKey[]>(() => {
  const providers = services.value?.providers;
  return providers ? ALL_PROVIDERS.filter((p) => providers[p]?.enabled) : [];
});

async function submit() {
  if (!identityValid.value) {
    step.value = STEP_GENERAL;
    return;
  }
  if (metadataHasError(form.value.metadata)) {
    step.value = STEP_ADVANCED;
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
      allowedResources: form.value.allowedResources.filter(Boolean),
      enabledSocialProviders: form.value.enabledSocialProviders,
      enableEndSession: form.value.enableEndSession,
      postLogoutRedirectUris: form.value.postLogoutRedirectUris.filter(Boolean),
      backchannelLogoutUri: form.value.backchannelLogoutUri || null,
      backchannelLogoutSessionRequired: form.value.backchannelLogoutSessionRequired,
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

// Enter moves on; it only saves on the last step.
function onEnter() {
  if (!isLastStep.value) next();
  else void submit();
}
</script>

<template>
  <SplitModal
    :open="open"
    :name="form.name || (isEdit ? t('applications.editApp') : t('applications.createApp'))"
    :subtitle="form.slug || 'app-slug'"
    :icon-url="form.icon || null"
    :icon-letter="form.name ? form.name[0].toUpperCase() : 'A'"
    :tags="tags"
    @close="emit('close')"
  >
    <!-- Stepper -->
    <nav
      class="shrink-0 px-4 sm:px-6 pt-5 pb-4 pr-14 sm:pr-14 border-b border-surface-800/60"
      :aria-label="t('applications.stepsLabel')"
    >
      <ol class="flex items-center gap-1 sm:gap-2">
        <template v-for="(s, i) in steps" :key="s.label">
          <li v-if="i > 0" class="h-px flex-1 bg-surface-700/60 hidden sm:block" aria-hidden="true" />
          <li>
            <button
              type="button"
              @click="goTo(i)"
              :disabled="i > STEP_GENERAL && !identityValid"
              :aria-current="i === step ? 'step' : undefined"
              :class="[
                'flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                i === step ? 'text-primary-300 bg-primary-600/15' : 'text-surface-400 hover:text-surface-200',
              ]"
            >
              <span
                :class="[
                  'w-6 h-6 shrink-0 rounded-full text-xs flex items-center justify-center border',
                  i === step
                    ? 'bg-primary-600 border-primary-500 text-white'
                    : i < step
                      ? 'border-primary-500/50 text-primary-300'
                      : 'border-surface-600 text-surface-500',
                ]"
              >
                {{ i < step ? '✓' : i + 1 }}
              </span>
              <span :class="['whitespace-nowrap', i === step ? '' : 'hidden md:inline']">{{ s.label }}</span>
            </button>
          </li>
        </template>
      </ol>
    </nav>

    <form @submit.prevent="onEnter" class="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5">
      <div class="mb-5">
        <h3 class="text-base font-semibold text-surface-100">
          {{ steps[step].label }}
          <span v-if="steps[step].optional" class="ml-2 text-xs font-normal text-surface-500">
            {{ t('applications.stepOptional') }}
          </span>
        </h3>
        <p class="text-sm text-surface-500 mt-0.5">{{ steps[step].hint }}</p>
      </div>

      <StepGeneral
        v-if="step === STEP_GENERAL"
        :form="form"
        :is-edit="isEdit"
        :icon-auto-detected="iconAutoDetected"
        @url-input="onUrlInput"
        @url-blur="lookupFavicon"
      />
      <StepOptions
        v-else-if="step === STEP_OPTIONS"
        v-model:litellm="litellmSupport"
        :form="form"
        :is-edit="isEdit"
        :litellm-available="litellmAvailable"
      />
      <StepAuthorization
        v-else-if="step === STEP_AUTHORIZATION"
        :form="form"
        :hidden-resources="hiddenResources"
      />
      <StepAdvanced v-else :form="form" :available-providers="availableProviders" />
    </form>

    <template #footer>
      <div class="flex flex-col-reverse sm:flex-row sm:items-center gap-2.5 w-full">
        <BaseButton variant="ghost" @click="emit('close')" class="w-full sm:w-auto sm:mr-auto">
          {{ t('common.cancel') }}
        </BaseButton>
        <BaseButton v-if="step > STEP_GENERAL" variant="outline" @click="step--" class="w-full sm:w-auto">
          {{ t('common.back') }}
        </BaseButton>
        <BaseButton
          v-if="!isLastStep"
          :variant="showSave ? 'secondary' : 'primary'"
          :disabled="!identityValid"
          @click="next"
          class="w-full sm:w-auto"
        >
          {{ t('common.next') }}
        </BaseButton>
        <BaseButton v-if="showSave" :loading="loading" :disabled="!identityValid" @click="submit" class="w-full sm:w-auto">
          {{ isEdit ? t('common.save') : t('applications.createApp') }}
        </BaseButton>
      </div>
    </template>
  </SplitModal>
</template>
