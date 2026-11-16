<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound, ShieldAlert, ShieldCheck } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import SshKeyFormModal from '@/components/profile/SshKeyFormModal.vue';
import { listRecipientKeys } from '@/api/resources';

const { t } = useI18n();

const count = ref<number | null>(null);
const showForm = ref(false);

async function load() {
  try {
    count.value = (await listRecipientKeys()).keys.length;
  } catch {
    count.value = null;
  }
}

onMounted(() => void load());
</script>

<template>
  <div
    v-if="count !== null"
    :class="[
      'flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3',
      count === 0 ? 'border-amber-500/30 bg-amber-500/10' : 'border-surface-700/40 bg-surface-900/40',
    ]"
    data-testid="ssh-identity-banner"
  >
    <component
      :is="count === 0 ? ShieldAlert : ShieldCheck"
      :class="['w-5 h-5 shrink-0', count === 0 ? 'text-amber-400' : 'text-emerald-400']"
    />
    <div class="min-w-0 flex-1">
      <p :class="['text-sm font-medium', count === 0 ? 'text-amber-200' : 'text-surface-200']">
        {{ count === 0 ? t('share.sshKeys.bannerNoneTitle') : t('share.sshKeys.bannerCount', { count }, count) }}
      </p>
      <p :class="['text-xs mt-0.5', count === 0 ? 'text-amber-200/80' : 'text-surface-500']">
        {{ count === 0 ? t('share.sshKeys.bannerNoneBody') : t('share.sshKeys.bannerManage') }}
      </p>
    </div>
    <RouterLink
      v-if="count > 0"
      :to="{ name: 'profile', query: { tab: 'security', security: 'ssh' } }"
      class="text-xs text-primary-300 hover:text-primary-200 underline"
    >
      {{ t('share.sshKeys.manage') }}
    </RouterLink>
    <BaseButton :variant="count === 0 ? 'primary' : 'outline'" size="sm" @click="showForm = true">
      <KeyRound class="w-3.5 h-3.5" />{{ t('share.sshKeys.add') }}
    </BaseButton>

    <SshKeyFormModal :open="showForm" @close="showForm = false" @saved="load" />
  </div>
</template>
