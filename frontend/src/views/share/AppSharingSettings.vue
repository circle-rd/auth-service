<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Pencil, Plus, Settings2, Trash2 } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import IconPicker from '@/components/ui/IconPicker.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import { ApiError } from '@/api/client';
import { useToast } from '@/composables/useToast';
import {
  createScheme,
  deleteScheme,
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
const deleting = ref(false);
const showForm = ref(false);
const editing = ref<ResourceScheme | null>(null);
const pendingDelete = ref<ResourceScheme | null>(null);
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
  Object.assign(form, { scheme: '', displayName: '', description: '', icon: 'box', validatorUrl: '' });
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
    const common = {
      displayName: form.displayName.trim(),
      description: form.description.trim() || null,
      icon: form.icon.trim() || null,
      validatorUrl: form.validatorUrl.trim() || null,
    };
    if (editing.value) {
      await updateScheme(props.appId, editing.value.scheme, common);
      toast.success(t('share.schemes.saved'));
    } else {
      await createScheme(props.appId, { scheme: form.scheme.trim().toLowerCase(), ...common });
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

async function toggle(scheme: ResourceScheme, enabled: boolean) {
  try {
    if (enabled) {
      await enableScheme(props.appId, scheme.scheme);
      toast.success(t('share.schemes.enabledToast'));
    } else {
      await disableScheme(props.appId, scheme.scheme);
      toast.success(t('share.schemes.disabledToast'));
    }
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

async function confirmDelete() {
  const target = pendingDelete.value;
  if (!target) return;
  deleting.value = true;
  try {
    await deleteScheme(props.appId, target.scheme);
    toast.success(t('share.schemes.deletedToast'));
    pendingDelete.value = null;
    await load();
  } catch (err) {
    const blocked = err instanceof ApiError && err.code === 'RES_013';
    toast.error(blocked ? t('share.schemes.deleteBlocked') : err instanceof Error ? err.message : t('share.saveError'));
    pendingDelete.value = null;
  } finally {
    deleting.value = false;
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
      <BaseButton size="sm" class="shrink-0" @click="openCreate">
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

    <ul v-else class="space-y-2" data-testid="scheme-list">
      <li
        v-for="scheme in schemes"
        :key="scheme.scheme"
        :data-testid="`scheme-${scheme.scheme}`"
        :class="[
          'flex items-center gap-4 rounded-2xl border bg-surface-900/40 px-4 py-3 transition-colors',
          scheme.enabled ? 'border-surface-700/40' : 'border-surface-800/60 opacity-80',
        ]"
      >
        <SchemeIcon :icon="scheme.icon" :scheme="scheme.scheme" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p class="font-medium text-surface-100 truncate">{{ scheme.displayName }}</p>
            <span class="font-mono text-[11px] text-surface-500">{{ scheme.scheme }}://</span>
            <BaseBadge :variant="scheme.owned ? 'primary' : 'neutral'" size="sm">
              {{ scheme.owned ? t('share.schemes.owned') : t('share.schemes.builtin') }}
            </BaseBadge>
            <span class="text-[10px] uppercase tracking-wide text-surface-600">{{ scheme.adapter }}</span>
          </div>
          <p class="text-xs text-surface-400 mt-0.5 line-clamp-2">
            {{ scheme.description || t('share.schemes.noDescription') }}
          </p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <BaseToggle
            :model-value="scheme.enabled"
            :aria-label="scheme.enabled ? t('common.deactivate') : t('common.activate')"
            class="mr-2"
            @update:model-value="toggle(scheme, $event)"
          />
          <template v-if="scheme.owned">
            <button
              type="button"
              class="p-2 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-surface-800/60 transition-colors"
              :title="t('common.edit')"
              :aria-label="t('common.edit')"
              @click="openEdit(scheme)"
            >
              <Pencil class="w-4 h-4" />
            </button>
            <button
              type="button"
              class="p-2 rounded-lg text-surface-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
              @click="pendingDelete = scheme"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </template>
          <template v-else>
            <span class="w-8" aria-hidden="true" />
            <span class="w-8" aria-hidden="true" />
          </template>
        </div>
      </li>
    </ul>

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
        <IconPicker v-model="form.icon" :label="t('share.schemes.icon')" :scheme="form.scheme" />
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

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('share.schemes.deleteTitle')"
      :message="t('share.schemes.deleteMessage', { name: pendingDelete?.displayName ?? '' })"
      :confirm-label="t('common.delete')"
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
