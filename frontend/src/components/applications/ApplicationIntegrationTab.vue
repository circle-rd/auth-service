<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Code, Copy, RefreshCw } from '@lucide/vue';
import * as appsApi from '@/api/applications';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import CopyField from '@/components/ui/CopyField.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { useToast } from '@/composables/useToast';
import { SCOPE_CATALOGUE } from '@/components/applications/form/scopes';
import type { Application, ServicesConfig } from '@/types';
import {
  ioserverExample,
  litellmPythonExample,
  litellmTypescriptExample,
  pythonExample,
  typescriptExample,
  type LitellmEndpoints,
} from '@/utils/integrationExamples';

const props = defineProps<{
  app: Application;
  servicesConfig: ServicesConfig | null;
  authServiceUrl: string;
}>();

const emit = defineEmits<{ rotate: [] }>();

const { t } = useI18n();
const toast = useToast();

type CodeTab = 'typescript' | 'python' | 'ioserver' | 'litellm-ts' | 'litellm-py';
const activeCodeTab = ref<CodeTab>('typescript');

const litellmEndpoints = ref<LitellmEndpoints | null>(null);
async function loadLitellmEndpoints() {
  try {
    const { applications } = await appsApi.listApplications();
    const gatewayUrl = applications.find((a) => a.slug === 'litellm')?.url;
    const authServiceUrl = applications.find((a) => a.slug === 'auth-service')?.url;
    litellmEndpoints.value =
      gatewayUrl && authServiceUrl && props.app.allowedResources.includes(gatewayUrl)
        ? { gatewayUrl, authServiceUrl }
        : null;
  } catch {
    litellmEndpoints.value = null;
  }
}
void loadLitellmEndpoints();

const codeExampleTS = computed(() => typescriptExample(props.app, props.authServiceUrl));
const codeExamplePython = computed(() => pythonExample(props.app, props.authServiceUrl));
const codeExampleIOServer = computed(() => ioserverExample(props.app, props.authServiceUrl));

const BASE_CODE_TABS: Array<{ key: CodeTab; label: string }> = [
  { key: 'typescript', label: 'TypeScript' },
  { key: 'python', label: 'Python' },
  { key: 'ioserver', label: 'IOServer' },
];
const LITELLM_CODE_TABS: Array<{ key: CodeTab; label: string }> = [
  { key: 'litellm-ts', label: 'LiteLLM · TypeScript' },
  { key: 'litellm-py', label: 'LiteLLM · Python' },
];
const codeTabs = computed(() =>
  litellmEndpoints.value ? [...BASE_CODE_TABS, ...LITELLM_CODE_TABS] : BASE_CODE_TABS,
);
const codeExampleLitellmTS = computed(() =>
  litellmEndpoints.value
    ? litellmTypescriptExample(props.app, props.authServiceUrl, litellmEndpoints.value)
    : '',
);
const codeExampleLitellmPython = computed(() =>
  litellmEndpoints.value
    ? litellmPythonExample(props.app, props.authServiceUrl, litellmEndpoints.value)
    : '',
);

const codeCopied = ref(false);
let codeCopiedTimer: ReturnType<typeof setTimeout> | undefined;
const activeCodeExample = computed(() => {
  switch (activeCodeTab.value) {
    case 'typescript':
      return codeExampleTS.value;
    case 'python':
      return codeExamplePython.value;
    case 'ioserver':
      return codeExampleIOServer.value;
    case 'litellm-ts':
      return codeExampleLitellmTS.value;
    case 'litellm-py':
      return codeExampleLitellmPython.value;
  }
});
const activeCodeLanguage = computed<'typescript' | 'python'>(() =>
  activeCodeTab.value === 'python' || activeCodeTab.value === 'litellm-py'
    ? 'python'
    : 'typescript',
);
async function copyActiveCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(activeCodeExample.value);
    codeCopied.value = true;
    toast.success(t('common.copied'));
    clearTimeout(codeCopiedTimer);
    codeCopiedTimer = setTimeout(() => {
      codeCopied.value = false;
    }, 1500);
  } catch {
    toast.error(t('common.copyError'));
  }
}

const PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;
type PKey = typeof PROVIDERS[number];
</script>

<template>
  <div class="grid grid-cols-1 xl:grid-cols-2 gap-5 xl:min-h-[420px]">
    <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 space-y-4">
      <CopyField :value="app.slug" :label="t('appDetail.clientId')" />
      <div v-if="!app.isPublic" class="space-y-2">
        <p class="text-xs font-medium text-surface-400 uppercase tracking-wide">{{ t('appDetail.clientSecret') }}</p>
        <div class="flex items-center gap-3">
          <div class="flex-1 px-3 py-2 bg-surface-800/60 border border-surface-700 rounded-lg text-sm font-mono text-surface-500">••••••••••••••••</div>
          <BaseButton variant="outline" size="sm" @click="emit('rotate')">
            <RefreshCw class="w-3.5 h-3.5" />{{ t('applications.rotateSecret') }}
          </BaseButton>
        </div>
      </div>
      <CopyField
        v-if="app.url"
        :value="app.url"
        :label="t('appDetail.resourceAudience')"
      />
      <div v-else class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
        <span class="shrink-0 mt-0.5">⚠</span>
        <span>{{ t('appDetail.noAppUrlWarning') }}</span>
      </div>
      <CopyField
        :value="`${authServiceUrl}/api/auth/jwks`"
        :label="t('appDetail.jwksUri')"
      />
      <CopyField
        :value="`${authServiceUrl}/api/auth/.well-known/openid-configuration`"
        :label="t('appDetail.discoveryEndpoint')"
      />
      <div>
        <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-2">{{ t('appDetail.redirectUris') }}</p>
        <div class="space-y-1.5">
          <div v-for="uri in app.redirectUris" :key="uri" class="px-3 py-1.5 bg-surface-800/60 border border-surface-700/40 rounded-lg font-mono text-xs text-surface-300">{{ uri }}</div>
        </div>
      </div>
      <div>
        <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-2">{{ t('appDetail.allowedScopes') }}</p>
        <div class="flex flex-wrap gap-1.5">
          <BaseBadge v-for="scope in app.allowedScopes" :key="scope" variant="neutral" size="sm">{{ scope }}</BaseBadge>
        </div>
      </div>
    </div>

    <div class="relative">
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 flex flex-col xl:absolute xl:inset-0">
        <div class="flex items-center gap-2 mb-4">
          <Code class="w-4 h-4 text-primary-400" />
          <p class="text-sm font-semibold text-surface-200">{{ t('appDetail.codeSnippet') }}</p>
          <button
            type="button"
            class="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-surface-400 hover:text-surface-100 hover:bg-surface-800/60 transition-colors"
            :title="t('common.copy')"
            @click="copyActiveCode"
          >
            <component :is="codeCopied ? Check : Copy" class="w-3.5 h-3.5" />
            {{ codeCopied ? t('common.copied') : t('common.copy') }}
          </button>
        </div>
        <div class="flex gap-1 p-1 bg-surface-950/60 rounded-lg border border-surface-800/50 w-fit mb-4">
          <button
            v-for="tab in codeTabs"
            :key="tab.key"
            @click="activeCodeTab = tab.key"
            :class="['px-3 py-1 rounded-md text-xs font-medium transition-all', activeCodeTab === tab.key ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-300']"
          >{{ tab.label }}</button>
        </div>
        <CodeBlock :code="activeCodeExample" :language="activeCodeLanguage" class="flex-1 min-h-0 max-h-[60vh] xl:max-h-none" />
        <p v-if="activeCodeTab === 'typescript'" class="mt-2 text-xs text-surface-500">{{ t('appDetail.snippetHintTypescript') }} <code class="font-mono">oauth4webapi</code></p>
        <p v-else-if="activeCodeTab === 'python'" class="mt-2 text-xs text-surface-500">{{ t('appDetail.snippetHintPython') }} <code class="font-mono">pip install authlib requests</code></p>
        <p v-else-if="activeCodeTab === 'litellm-ts'" class="mt-2 text-xs text-surface-500">{{ t('appDetail.snippetHintLiteLlmTypescript') }} <code class="font-mono">npm i oauth4webapi openai</code></p>
        <p v-else-if="activeCodeTab === 'litellm-py'" class="mt-2 text-xs text-surface-500">{{ t('appDetail.snippetHintLiteLlmPython') }} <code class="font-mono">pip install authlib requests openai</code></p>
        <p v-else class="mt-2 text-xs text-surface-500">{{ t('appDetail.snippetHintIoserver') }} <code class="font-mono">npm i ioserver-oidc</code></p>
      </div>
    </div>

    <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
      <p class="text-sm font-semibold text-surface-200 mb-3">{{ t('appDetail.scopesAndClaims') }}</p>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-surface-800/40">
              <th class="text-left py-2 pr-4 text-surface-500 font-medium w-32">Scope</th>
              <th class="text-left py-2 pr-4 text-surface-500 font-medium w-24">Type</th>
              <th class="text-left py-2 text-surface-500 font-medium">Claims returned</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-800/30">
            <tr v-for="info in SCOPE_CATALOGUE" :key="info.scope">
              <td class="py-2 pr-4">
                <code :class="['font-mono px-1.5 py-0.5 rounded text-xs', app.allowedScopes.includes(info.scope) ? 'bg-primary-600/15 text-primary-300' : 'bg-surface-800/50 text-surface-500']">{{ info.scope }}</code>
              </td>
              <td class="py-2 pr-4">
                <BaseBadge :variant="info.group === 'standard' ? 'success' : 'neutral'" size="sm">{{ info.group === 'standard' ? t('appDetail.standardOidc') : t('appDetail.customScope') }}</BaseBadge>
              </td>
              <td class="py-2 text-surface-400 font-mono">{{ info.claims }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-2 text-xs text-surface-600">* <code class="font-mono">company</code> is a proprietary claim inside the standard <code class="font-mono">profile</code> scope.</p>
      </div>
    </div>

    <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
      <p class="text-sm font-semibold text-surface-200 mb-3">{{ t('appDetail.socialProviders') }}</p>
      <div class="space-y-2">
        <div v-for="key in PROVIDERS" :key="key" class="flex items-center justify-between py-2">
          <p class="text-sm text-surface-300 capitalize">{{ key }}</p>
          <div class="flex items-center gap-2">
            <BaseBadge
              v-if="app.enabledSocialProviders === null"
              :variant="servicesConfig?.providers[key as PKey]?.enabled ? 'success' : 'neutral'"
              size="sm"
            >
              {{ servicesConfig?.providers[key as PKey]?.enabled ? t('appDetail.inheritedOn') : t('appDetail.inheritedOff') }}
            </BaseBadge>
            <BaseBadge
              v-else
              :variant="app.enabledSocialProviders?.includes(key) ? 'success' : 'neutral'"
              size="sm"
            >
              {{ app.enabledSocialProviders?.includes(key) ? t('common.enabled') : t('common.disabled') }}
            </BaseBadge>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
