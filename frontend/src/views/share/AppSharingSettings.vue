<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Settings2 } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  createScheme,
  disableScheme,
  enableScheme,
  listSchemeCatalog,
  updateScheme,
  type ResourceScheme,
} from '@/api/resources';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();

const schemes = ref<ResourceScheme[]>([]);
const loading = ref(true);
const saving = ref(false);
const showForm = ref(false);
const editing = ref<ResourceScheme | null>(null);
const form = reactive({
  scheme: '',
  displayName: '',
  description: '',
  icon: '',
  validatorUrl: '',
});

const canSave = computed(
  () => form.scheme.trim().length > 0 && form.displayName.trim().length > 0,
);

async function load() {
  loading.value = true;
  try {
    schemes.value = (await listSchemeCatalog(props.appId)).schemes;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, { scheme: '', displayName: '', description: '', icon: '', validatorUrl: '' });
  showForm.value = true;
}

function openEdit(scheme: ResourceScheme) {
  editing.value = scheme;
  Object.assign(form, {
    scheme: scheme.scheme,
    displayName: scheme.displayName,
    description: scheme.description ?? '',
    icon: scheme.icon ?? '',
    validatorUrl: scheme.validatorUrl ?? '',
  });
  showForm.value = true;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    if (editing.value) {
      await updateScheme(props.appId, editing.value.scheme, {
        displayName: form.displayName.trim(),
        description: form.description.trim() || null,
        icon: form.icon.trim() || null,
        validatorUrl: form.validatorUrl.trim() || null,
      });
      toast.success(t('share.schemes.saved'));
    } else {
      await createScheme(props.appId, {
        scheme: form.scheme.trim().toLowerCase(),
        displayName: form.displayName.trim(),
        description: form.description.trim() || null,
        icon: form.icon.trim() || null,
        validatorUrl: form.validatorUrl.trim() || null,
      });
      toast.success(t('share.schemes.created'));
    }
    showForm.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

async function toggle(scheme: ResourceScheme) {
  try {
    if (scheme.enabled) {
      await disableScheme(props.appId, scheme.scheme);
      toast.success(t('share.schemes.disabledToast'));
    } else {
      await enableScheme(props.appId, scheme.scheme);
      toast.success(t('share.schemes.enabledToast'));
    }
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-sm text-surface-300">{{ t('share.schemes.hint') }}</p>
        <p class="text-xs text-surface-500 mt-1">{{ t('share.schemes.adminHint') }}</p>
      </div>
      <BaseButton size="sm" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.schemes.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="schemes.length === 0"
      :title="t('share.schemes.empty')"
      :message="t('share.schemes.emptyHint')"
    >
      <template #icon><Settings2 class="w-8 h-8 text-surface-500" /></template>
    </EmptyState>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div
        v-for="scheme in schemes"
        :key="scheme.scheme"
        class="rounded-2xl border border-surface-700/40 bg-surface-900/40 p-4 space-y-3"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-medium text-surface-100">{{ scheme.displayName }}</p>
            <p class="font-mono text-[11px] text-surface-500">{{ scheme.scheme }}://</p>
          </div>
          <BaseBadge :variant="scheme.enabled ? 'success' : 'neutral'" dot>
            {{ scheme.enabled ? t('common.enabled') : t('common.disabled') }}
          </BaseBadge>
        </div>
        <p class="text-xs text-surface-400">{{ scheme.description || t('share.schemes.noDescription') }}</p>
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-surface-500">
          <span class="uppercase tracking-wide">{{ scheme.adapter }}</span>
          <span v-if="scheme.owned" class="text-primary-300">{{ t('share.schemes.owned') }}</span>
        </div>
        <div class="flex justify-end gap-1">
          <BaseButton v-if="scheme.owned" variant="ghost" size="sm" @click="openEdit(scheme)">
            {{ t('common.edit') }}
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="toggle(scheme)">
            {{ scheme.enabled ? t('common.deactivate') : t('common.activate') }}
          </BaseButton>
        </div>
      </div>
    </div>

    <BaseModal
      :open="showForm"
      :title="editing ? t('share.schemes.editTitle') : t('share.schemes.registerTitle')"
      size="md"
      @close="showForm = false"
    >
      <div class="space-y-4">
        <BaseInput
          v-if="!editing"
          v-model="form.scheme"
          :label="t('share.schemes.scheme')"
          required
          :hint="t('share.schemes.schemeHint')"
        />
        <BaseInput v-model="form.displayName" :label="t('share.schemes.displayName')" required />
        <BaseInput v-model="form.description" :label="t('share.schemes.description')" />
        <BaseInput v-model="form.icon" :label="t('share.schemes.icon')" />
        <BaseInput
          v-model="form.validatorUrl"
          :label="t('share.schemes.validatorUrl')"
          :hint="t('share.schemes.validatorUrlHint')"
        />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!canSave" @click="save">{{ t('common.save') }}</BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
