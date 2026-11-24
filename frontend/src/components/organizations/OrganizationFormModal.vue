<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  createOrganization,
  requestDomainVerification,
  updateOrganization,
  verifyOrganizationDomain,
  type DomainVerificationRecord,
} from '@/api/organizations';
import { useToast } from '@/composables/useToast';
import type { Organization } from '@/types';
import SplitModal from '@/components/ui/SplitModal.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import OrganizationLogoPicker from './OrganizationLogoPicker.vue';
import { BadgeCheck, Check, Copy, UserPlus } from '@lucide/vue';

const props = defineProps<{
  open: boolean;
  organization?: Organization | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [organization: Organization];
}>();

const { t } = useI18n();
const toast = useToast();

const current = ref<Organization | null>(null);
const form = ref({
  name: '',
  slug: '',
  logo: '',
  domain: '',
  metadata: '',
  autoEnrollEnabled: false,
  verifyDomain: false,
});
const challenge = ref<DomainVerificationRecord | null>(null);
const loading = ref(false);
const busy = ref(false);
const copied = ref(false);

const isEdit = computed(() => !!current.value);
const normalizeDomain = (value: string) => value.trim().toLowerCase();
const domainChanged = computed(
  () => normalizeDomain(form.value.domain) !== normalizeDomain(current.value?.domain ?? ''),
);
const verifiedAt = computed(() => {
  if (!current.value?.domainVerifiedAt) return null;
  return domainChanged.value ? null : current.value.domainVerifiedAt;
});
const subtitle = computed(
  () => form.value.domain || form.value.slug || 'org-slug',
);
const shortRecordName = computed(() => {
  const name = challenge.value?.recordName ?? '';
  return name.startsWith('_circle-auth.') ? '_circle-auth' : name;
});

type Tag = {
  label: string;
  variant: 'success' | 'info' | 'warning' | 'neutral';
  icon?: Component;
};

const tags = computed<Tag[]>(() => {
  const out: Tag[] = [];
  if (verifiedAt.value) {
    out.push({
      label: t('organizations.domainVerified'),
      variant: 'info',
      icon: BadgeCheck,
    });
  } else if (form.value.verifyDomain && form.value.domain) {
    out.push({
      label: t('organizations.verificationPending'),
      variant: 'warning',
    });
  }
  if (verifiedAt.value && form.value.autoEnrollEnabled) {
    out.push({
      label: t('organizations.autoEnrollActive'),
      variant: 'success',
      icon: UserPlus,
    });
  }
  return out;
});

function challengeFromOrganization(org: Organization | null): DomainVerificationRecord | null {
  if (!org?.domain || !org.domainVerificationToken || org.domainVerifiedAt) {
    return null;
  }
  return {
    recordName: `_circle-auth.${org.domain}`,
    recordValue: `circle-auth-verification=${org.domainVerificationToken}`,
  };
}

function reset() {
  const org = props.organization ?? null;
  current.value = org;
  form.value = {
    name: org?.name ?? '',
    slug: org?.slug ?? '',
    logo: org?.logo ?? '',
    domain: org?.domain ?? '',
    metadata: org?.metadata ?? '',
    autoEnrollEnabled: org?.autoEnrollEnabled ?? false,
    verifyDomain:
      !!org?.domain && (!!org.domainVerifiedAt || !!org.domainVerificationToken),
  };
  challenge.value = challengeFromOrganization(org);
  copied.value = false;
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
  { immediate: true },
);

watch(
  () => form.value.domain,
  (value, previous) => {
    if (!props.open || normalizeDomain(value) === normalizeDomain(previous ?? '')) return;
    if (
      current.value &&
      normalizeDomain(value) === normalizeDomain(current.value.domain ?? '')
    ) {
      // The administrator reverted to the saved domain: restore its state.
      form.value.verifyDomain =
        !!verifiedAt.value || !!current.value.domainVerificationToken;
      challenge.value = challengeFromOrganization(current.value);
      return;
    }
    // A different domain invalidates the displayed proof and challenge. The
    // new record is generated when the organization is saved.
    form.value.verifyDomain = false;
    form.value.autoEnrollEnabled = false;
    challenge.value = null;
  },
);

async function onVerifyToggle(next: boolean) {
  if (!next) {
    form.value.verifyDomain = false;
    form.value.autoEnrollEnabled = false;
    challenge.value = null;
    return;
  }
  if (!form.value.domain) {
    toast.error(t('organizations.domainRequired'));
    return;
  }
  form.value.verifyDomain = true;

  if (!current.value || domainChanged.value || current.value.domainVerifiedAt) {
    // A new/changed domain gets its challenge on save. A verified domain needs
    // no new challenge.
    return;
  }
  if (current.value.domainVerificationToken) {
    challenge.value = challengeFromOrganization(current.value);
    return;
  }

  busy.value = true;
  try {
    const res = await requestDomainVerification(current.value.id);
    current.value = res.organization;
    challenge.value = res.domainVerification;
    form.value.verifyDomain = true;
    emit('saved', res.organization);
  } catch (err) {
    form.value.verifyDomain = false;
    toast.error(
      err instanceof Error
        ? err.message
        : t('organizations.domainVerificationFailed'),
    );
  } finally {
    busy.value = false;
  }
}

async function checkDomain() {
  if (!current.value) return;
  busy.value = true;
  try {
    const res = await verifyOrganizationDomain(current.value.id);
    current.value = res.organization;
    challenge.value = null;
    form.value.verifyDomain = true;
    form.value.autoEnrollEnabled = res.organization.autoEnrollEnabled ?? false;
    emit('saved', res.organization);
    toast.success(t('organizations.domainVerifiedSuccess'));
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : t('organizations.domainVerificationFailed'),
    );
  } finally {
    busy.value = false;
  }
}

async function onAutoEnrollToggle(next: boolean) {
  if (!verifiedAt.value) {
    toast.error(t('organizations.domainRequired'));
    return;
  }
  form.value.autoEnrollEnabled = next;
  if (!current.value) return;

  busy.value = true;
  try {
    const res = await updateOrganization(current.value.id, {
      autoEnrollEnabled: next,
    });
    current.value = res.organization;
    form.value.autoEnrollEnabled = res.organization.autoEnrollEnabled ?? next;
    emit('saved', res.organization);
    toast.success(
      next
        ? t('organizations.autoEnrollEnabled')
        : t('organizations.autoEnrollDisabled'),
    );
  } catch (err) {
    form.value.autoEnrollEnabled = !next;
    toast.error(
      err instanceof Error
        ? err.message
        : t('organizations.domainVerificationFailed'),
    );
  } finally {
    busy.value = false;
  }
}

async function copyRecord() {
  if (!challenge.value) return;
  await navigator.clipboard.writeText(challenge.value.recordValue);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}

async function submit() {
  loading.value = true;
  try {
    const common = {
      name: form.value.name,
      slug: form.value.slug,
      domain: form.value.domain || null,
      verifyDomain: form.value.verifyDomain,
      autoEnrollEnabled: form.value.autoEnrollEnabled,
      metadata: form.value.metadata || undefined,
    };
    const res = current.value
      ? await updateOrganization(current.value.id, {
          ...common,
          logo: form.value.logo || null,
        })
      : await createOrganization({
          name: form.value.name,
          slug: form.value.slug,
          ...(form.value.logo ? { logo: form.value.logo } : {}),
          ...(form.value.domain ? { domain: form.value.domain } : {}),
          verifyDomain: form.value.verifyDomain,
          metadata: form.value.metadata || undefined,
        });

    current.value = res.organization;
    emit('saved', res.organization);

    if (res.domainVerification) {
      challenge.value = res.domainVerification;
      form.value.verifyDomain = true;
      toast.success(
        isEdit.value
          ? t('organizations.updated')
          : t('organizations.created'),
      );
      return;
    }

    toast.success(
      isEdit.value ? t('organizations.updated') : t('organizations.created'),
    );
    emit('close');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('organizations.saveFailed'));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <SplitModal
    :open="open"
    height="auto"
    :name="form.name || (isEdit ? t('organizations.editOrg') : t('organizations.createOrg'))"
    :subtitle="subtitle"
    :icon-url="form.logo || null"
    :icon-letter="(form.name || 'O')[0].toUpperCase()"
    :tags="tags"
    @close="emit('close')"
  >
    <template #identity-icon>
      <OrganizationLogoPicker
        v-model="form.logo"
        :name="form.name || t('organizations.createOrg')"
        @error="(message) => toast.error(message)"
      />
    </template>

    <form
      class="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5 space-y-5"
      @submit.prevent="submit"
    >
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <BaseInput v-model="form.name" :label="t('organizations.name')" required />
        <BaseInput
          v-model="form.slug"
          :label="t('organizations.slug')"
          :disabled="isEdit"
          required
        />
      </div>

      <BaseInput
        v-model="form.domain"
        :label="t('organizations.domain')"
        :hint="t('organizations.domainHint')"
        placeholder="example.com"
      />

      <div class="rounded-xl border border-surface-700/40 bg-surface-800/20 p-4 space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium text-surface-200">
              {{ t('organizations.verifyDomain') }}
            </p>
            <p class="text-xs text-surface-500 mt-0.5">
              {{ t('organizations.verifyDomainHint') }}
            </p>
          </div>
          <BaseToggle
            :model-value="form.verifyDomain"
            :disabled="!form.domain || busy || !!verifiedAt"
            @update:model-value="onVerifyToggle"
          />
        </div>

        <template v-if="form.verifyDomain && !verifiedAt">
          <div
            v-if="challenge"
            class="flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-900/70 px-3 py-2"
          >
            <span class="text-[10px] font-semibold uppercase tracking-wider text-surface-500">TXT</span>
            <code class="shrink-0 text-xs font-mono text-surface-300">{{ shortRecordName }}</code>
            <span class="text-surface-600">→</span>
            <code class="min-w-0 flex-1 truncate text-xs font-mono text-surface-300">{{ challenge.recordValue }}</code>
            <button
              type="button"
              class="shrink-0 p-1 rounded text-surface-500 hover:text-surface-200 transition-colors"
              :aria-label="t('common.copy')"
              @click="copyRecord"
            >
              <Check v-if="copied" class="w-4 h-4 text-emerald-400" />
              <Copy v-else class="w-4 h-4" />
            </button>
            <BaseButton
              variant="ghost"
              size="sm"
              class="!px-1.5"
              :loading="busy"
              :aria-label="t('organizations.verifyDns')"
              @click="checkDomain"
            >
              <Check v-if="!busy" class="w-4 h-4 text-emerald-400" />
            </BaseButton>
          </div>
          <p v-else class="text-xs text-surface-500">
            {{ t('organizations.saveToGenerateRecord') }}
          </p>
        </template>

        <div
          v-if="verifiedAt"
          class="flex items-start justify-between gap-4 border-t border-surface-700/30 pt-3"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium text-surface-200">
              {{ t('organizations.autoEnroll') }}
            </p>
            <p class="text-xs text-surface-500 mt-0.5">
              {{ t('organizations.autoEnrollHint') }}
            </p>
          </div>
          <BaseToggle
            :model-value="form.autoEnrollEnabled"
            :disabled="busy"
            :label="t('common.activate')"
            @update:model-value="onAutoEnrollToggle"
          />
        </div>
      </div>

      <BaseInput v-model="form.metadata" :label="t('organizations.metadata')" />
    </form>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">
        {{ t('common.cancel') }}
      </BaseButton>
      <BaseButton :loading="loading" :disabled="!form.name || !form.slug" @click="submit">
        {{ isEdit ? t('common.save') : t('common.create') }}
      </BaseButton>
    </template>
  </SplitModal>
</template>
