<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Building2, Globe, Layers, Lock, Server, Sparkles, Terminal, User } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import SearchSelect from '@/components/ui/SearchSelect.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import UriInput from '@/components/ui/UriInput.vue';
import { getMyOrganizations } from '@/api/organizations';
import { useRealtimeEvents, type RealtimeEventsHandle } from '@/composables/useRealtimeEvents';
import { coalesceRefresh } from '@/utils/coalesceRefresh';
import { useAuthStore } from '@/stores/auth';
import {
  listManagedModelCandidates,
  listNativeModelCandidates,
  listOwnerMembers,
  listOwnerPlans,
  type ModelCandidate,
  type OwnerPlan,
  type ResourceAudience,
} from '@/api/resources';
import { locatorSpec } from '@/utils/schemeLocator';
import { resolveSchemeIcon } from '@/utils/schemeIcons';
import type { Resource, ResourceScheme } from '@/api/resources';
import type { SelectOption } from '@/types/select';

export interface ResourceFormPayload {
  scheme: string;
  displayName: string;
  locator: string | undefined;
  audience: ResourceAudience | undefined;
}

type AudienceChoice = 'private' | 'everyone' | 'plan' | 'organization' | 'user';

const props = defineProps<{
  open: boolean;
  appId: string;
  schemes: ResourceScheme[];
  // Scheme preselected on creation; the type picker is hidden when it is fixed.
  fixedScheme?: string;
  editing: Resource | null;
  saving: boolean;
  error: string;
  // Offers the destination picker; only the application's administrators get the audiences
  // that reach beyond one member.
  audienceEnabled?: boolean;
  isAppAdmin?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [payload: ResourceFormPayload];
}>();

const { t } = useI18n();
const auth = useAuthStore();

const form = reactive({ scheme: '', displayName: '', locator: '' });
const audience = reactive<{ choice: AudienceChoice; planId: string; organizationId: string; userId: string }>({
  choice: 'private',
  planId: '',
  organizationId: '',
  userId: '',
});
const candidates = ref<ModelCandidate[]>([]);
const candidatesLoading = ref(false);
let catalogueEvents: RealtimeEventsHandle | null = null;
const plans = ref<OwnerPlan[]>([]);
const organizations = ref<Array<{ id: string; name: string }>>([]);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      stopCatalogueFollow();
      return;
    }
    form.scheme = props.editing?.scheme ?? props.fixedScheme ?? props.schemes[0]?.scheme ?? '';
    form.displayName = props.editing?.displayName ?? '';
    form.locator = props.editing ? props.editing.uri.slice(props.editing.scheme.length + 3) : '';
    audience.choice = 'private';
    audience.planId = '';
    audience.organizationId = '';
    audience.userId = '';
    void loadCandidates();
    void loadAudienceTargets();
    followCatalogue();
  },
);

onUnmounted(stopCatalogueFollow);

watch(
  () => form.scheme,
  (scheme) => {
    if (props.open && !props.editing && scheme === 'llm') void loadCandidates();
  },
);

const scheme = computed(() => props.schemes.find((entry) => entry.scheme === form.scheme) ?? null);
const isSsh = computed(() => form.scheme === 'ssh');
const isLlm = computed(() => form.scheme === 'llm');
const spec = computed(() => locatorSpec(form.scheme));

const schemeOptions = computed<SelectOption[]>(() =>
  props.schemes.map((entry) => {
    const resolved = resolveSchemeIcon(entry.icon, entry.scheme);
    return {
      value: entry.scheme,
      label: entry.displayName,
      description: entry.description ?? undefined,
      icon: resolved.kind === 'component' ? resolved.component : undefined,
    };
  }),
);

const modelOptions = computed<SelectOption[]>(() =>
  candidates.value.map((model) => ({
    value: model.locator,
    label: model.name,
    description: modelDescription(model),
    group: model.kind === 'router' ? t('share.resources.modelGroups.routers') : t('share.resources.modelGroups.models'),
    icon: model.kind === 'router' ? Layers : model.source === 'managed' ? Sparkles : Server,
  })),
);

function modelDescription(model: ModelCandidate): string {
  const parts = [
    model.kind === 'router'
      ? t('share.resources.modelKinds.router')
      : model.source === 'managed'
        ? t('share.resources.modelSources.managed')
        : t('share.resources.modelSources.native'),
  ];
  if (model.tags.length > 0) parts.push(model.tags.join(', '));
  if (model.owned) parts.push(t('share.resources.modelOwned'));
  return parts.join(' · ');
}

async function loadModelOptions(search: string): Promise<SelectOption[]> {
  const term = search.trim().toLowerCase();
  if (!term) return modelOptions.value;
  return modelOptions.value.filter((option) =>
    `${option.label} ${option.description ?? ''}`.toLowerCase().includes(term),
  );
}

/**
 * Model pickers are open only while the modal is: the catalogue event is what keeps them
 * current. A change announced while a load is in flight is replayed, never lost.
 */
function followCatalogue(): void {
  stopCatalogueFollow();
  if (props.editing) return;
  catalogueEvents = useRealtimeEvents(
    { 'catalogue.changed': () => void loadCandidates() },
    { onResync: () => void loadCandidates() },
  );
}

function stopCatalogueFollow(): void {
  catalogueEvents?.close();
  catalogueEvents = null;
}

const refreshCandidates = coalesceRefresh(async () => {
  try {
    const [managed, native] = await Promise.all([
      listManagedModelCandidates(props.appId),
      listNativeModelCandidates(props.appId),
    ]);
    candidates.value = [...managed.models, ...native.models].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'router' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  } catch {
    candidates.value = [];
  }
});

async function loadCandidates(): Promise<void> {
  if (props.editing || !isLlm.value) return;
  candidatesLoading.value = true;
  try {
    await refreshCandidates();
  } finally {
    candidatesLoading.value = false;
  }
}

const audienceOptions = computed<SelectOption[]>(() => {
  const options: SelectOption[] = [
    { value: 'private', label: t('share.resources.audience.private.label'), description: t('share.resources.audience.private.description'), icon: Lock },
  ];
  if (!props.audienceEnabled || !props.isAppAdmin) return options;
  options.push(
    { value: 'everyone', label: t('share.resources.audience.everyone.label'), description: t('share.resources.audience.everyone.description'), icon: Globe },
    { value: 'plan', label: t('share.resources.audience.plan.label'), description: t('share.resources.audience.plan.description'), icon: Layers },
    { value: 'organization', label: t('share.resources.audience.organization.label'), description: t('share.resources.audience.organization.description'), icon: Building2 },
    { value: 'user', label: t('share.resources.audience.user.label'), description: t('share.resources.audience.user.description'), icon: User },
  );
  return options;
});

const showAudience = computed(() => !props.editing && audienceOptions.value.length > 1);
const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((plan) => ({ value: plan.id, label: plan.name, description: plan.description ?? undefined, icon: Layers })),
);
const organizationOptions = computed<SelectOption[]>(() =>
  organizations.value.map((org) => ({ value: org.id, label: org.name, icon: Building2 })),
);

async function loadAudienceTargets(): Promise<void> {
  if (props.editing || !props.audienceEnabled || !props.isAppAdmin) {
    plans.value = [];
    organizations.value = [];
    return;
  }
  try {
    const [planRes, orgRes] = await Promise.all([listOwnerPlans(props.appId), getMyOrganizations()]);
    plans.value = planRes.plans;
    organizations.value = orgRes.organizations;
  } catch {
    plans.value = [];
    organizations.value = [];
  }
}

async function loadUserOptions(search: string): Promise<SelectOption[]> {
  const page = await listOwnerMembers(props.appId, { limit: 20, q: search.trim() || undefined });
  return page.members
    .filter((member) => member.userId !== auth.user?.id)
    .map((member) => ({
    value: member.userId,
    label: member.name,
    description: member.email ?? undefined,
    icon: User,
  }));
}

function audiencePayload(): ResourceAudience | undefined {
  switch (audience.choice) {
    case 'private':
      return undefined;
    case 'everyone':
      return { type: 'everyone' };
    case 'plan':
      return audience.planId ? { type: 'plan', planId: audience.planId } : undefined;
    case 'organization':
      return audience.organizationId ? { type: 'organization', organizationId: audience.organizationId } : undefined;
    case 'user':
      return audience.userId ? { type: 'user', userId: audience.userId } : undefined;
  }
}

const title = computed(
  () => form.displayName.trim() || scheme.value?.displayName || t('share.resources.createTitle'),
);
const subtitle = computed(() => {
  if (props.editing) return props.editing.uri;
  if (isSsh.value) return `${form.scheme}://`;
  return `${form.scheme}://${form.locator.trim()}`;
});
const tags = computed(() => {
  const list: Array<{ label: string; variant: 'primary' | 'success' | 'warning' | 'neutral' }> = [];
  if (scheme.value) list.push({ label: scheme.value.displayName, variant: 'primary' });
  if (props.editing) {
    const status = props.editing.status;
    list.push({
      label: t(`share.resourceStatuses.${status}`),
      variant: status === 'validated' ? 'success' : status === 'disabled' ? 'neutral' : 'warning',
    });
  }
  return list;
});

const audienceComplete = computed(() => audience.choice === 'private' || audiencePayload() !== undefined);

const canSave = computed(() => {
  if (form.displayName.trim().length === 0) return false;
  if (props.editing) return true;
  if (!audienceComplete.value) return false;
  if (isLlm.value && candidates.value.length === 0) return false;
  return form.scheme.length > 0 && (isSsh.value || form.locator.trim().length > 0);
});

function submit() {
  if (!canSave.value || props.saving) return;
  emit('submit', {
    scheme: form.scheme,
    displayName: form.displayName.trim(),
    locator: isSsh.value || props.editing ? undefined : form.locator.trim(),
    audience: props.editing ? undefined : audiencePayload(),
  });
}
</script>

<template>
  <EntityModal
    :open="open"
    :name="title"
    :subtitle="subtitle"
    :tags="tags"
    size="md"
    @close="emit('close')"
  >
    <template #icon>
      <SchemeIcon :icon="scheme?.icon" :scheme="form.scheme" size="lg" />
    </template>

    <form class="space-y-4" @submit.prevent="submit">
      <p v-if="scheme?.description" class="text-sm text-surface-400">{{ scheme.description }}</p>

      <BaseSelect
        v-if="!editing && !fixedScheme"
        v-model="form.scheme"
        :label="t('share.resources.scheme')"
        :options="schemeOptions"
      />

      <BaseInput v-model="form.displayName" :label="t('share.resources.name')" required />

      <UriInput
        v-if="editing"
        :model-value="form.locator"
        :prefix="form.scheme"
        :label="t('share.resources.locator')"
        :hint="t('share.resources.locatorImmutable')"
        readonly
      />
      <template v-else-if="isLlm">
        <SearchSelect
          v-model="form.locator"
          :label="t('share.resources.model')"
          :load-options="loadModelOptions"
          :placeholder="candidatesLoading ? t('share.resources.modelsLoading') : t('share.resources.modelsPlaceholder')"
          :disabled="candidatesLoading || modelOptions.length === 0"
          required
        />
        <p v-if="!candidatesLoading && modelOptions.length === 0" class="text-xs text-surface-500">
          {{ t('share.resources.modelsEmpty') }}
        </p>
      </template>
      <UriInput
        v-else-if="!isSsh"
        v-model="form.locator"
        :prefix="form.scheme"
        :label="t('share.resources.locator')"
        :placeholder="spec.placeholder"
        :hint="t(`share.resources.locatorHints.${spec.hintKey}`)"
        :error="error"
        required
      />
      <div
        v-else
        class="flex items-start gap-3 rounded-xl border border-surface-700/50 bg-surface-950/40 p-3"
      >
        <Terminal class="w-4 h-4 text-surface-400 mt-0.5 shrink-0" />
        <p class="text-xs text-surface-400">{{ t('share.resources.sshLocatorHint') }}</p>
      </div>

      <section v-if="showAudience" class="space-y-3">
        <BaseSelect
          v-model="audience.choice"
          :label="t('share.resources.audience.label')"
          :options="audienceOptions"
          show-selected-description
        />
        <BaseSelect
          v-if="audience.choice === 'plan'"
          v-model="audience.planId"
          :label="t('share.resources.audience.plan.target')"
          :options="planOptions"
          :placeholder="t('share.resources.audience.plan.placeholder')"
          :disabled="planOptions.length === 0"
          required
        />
        <BaseSelect
          v-else-if="audience.choice === 'organization'"
          v-model="audience.organizationId"
          :label="t('share.resources.audience.organization.target')"
          :options="organizationOptions"
          :placeholder="t('share.resources.audience.organization.placeholder')"
          :disabled="organizationOptions.length === 0"
          required
        />
        <SearchSelect
          v-else-if="audience.choice === 'user'"
          v-model="audience.userId"
          :label="t('share.resources.audience.user.target')"
          :load-options="loadUserOptions"
          :placeholder="t('share.resources.audience.user.placeholder')"
          required
        />
        <p v-if="audience.choice === 'everyone' || audience.choice === 'plan' || audience.choice === 'organization'" class="text-xs text-surface-500">
          {{ t('share.resources.audience.pendingHint') }}
        </p>
      </section>

      <p v-if="error && (editing || isSsh)" class="text-xs text-red-400">{{ error }}</p>

      <div
        v-if="editing?.validationError"
        class="rounded-xl border border-red-500/30 bg-red-500/5 p-3 space-y-1"
      >
        <BaseBadge variant="error">{{ t('share.resourceStatuses.validation_failed') }}</BaseBadge>
        <p class="text-xs text-red-300">{{ editing.validationError }}</p>
      </div>

      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="saving" :disabled="!canSave" @click="submit">{{ t('common.save') }}</BaseButton>
    </template>
  </EntityModal>
</template>
