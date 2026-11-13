<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { CircleCheck, CircleAlert } from '@lucide/vue';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { ApiError } from '@/api/client';
import { acceptInvitation, type ResourceGrant } from '@/api/resources';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''));
const accepting = ref(false);
const grant = ref<ResourceGrant | null>(null);
const error = ref<ApiError | null>(null);

async function accept() {
  if (!token.value) return;
  accepting.value = true;
  error.value = null;
  try {
    const res = await acceptInvitation(token.value);
    grant.value = res.grant;
  } catch (err) {
    error.value = err instanceof ApiError ? err : new ApiError('UNKNOWN', t('share.invitation.unknownError'));
  } finally {
    accepting.value = false;
  }
}
</script>

<template>
  <AppLayout :title="t('share.invitation.title')" :subtitle="t('share.invitation.subtitle')">
    <div class="max-w-xl">
      <div v-if="!token" class="rounded-2xl border border-red-500/30 bg-red-500/5 p-5">
        <div class="flex items-start gap-3">
          <CircleAlert class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <p class="text-sm font-medium text-red-300">{{ t('share.invitation.missingToken') }}</p>
            <p class="text-xs text-surface-400 mt-1">{{ t('share.invitation.missingTokenHint') }}</p>
          </div>
        </div>
      </div>

      <div v-else-if="grant" class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-4">
        <div class="flex items-start gap-3">
          <CircleCheck class="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <p class="text-sm font-medium text-emerald-300">{{ t('share.invitation.accepted') }}</p>
            <p class="text-xs text-surface-400 mt-1">{{ t('share.invitation.acceptedHint') }}</p>
          </div>
        </div>
        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt class="text-xs uppercase tracking-wide text-surface-500">{{ t('share.invitation.plan') }}</dt>
            <dd class="text-surface-200 mt-0.5">{{ grant.planName }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-surface-500">{{ t('share.invitation.expires') }}</dt>
            <dd class="text-surface-200 mt-0.5">{{ grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '—' }}</dd>
          </div>
        </dl>
        <BaseButton variant="outline" @click="router.push('/share')">{{ t('share.invitation.back') }}</BaseButton>
      </div>

      <div v-else-if="error" class="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 space-y-3">
        <div class="flex items-start gap-3">
          <CircleAlert class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <p class="text-sm font-medium text-red-300">{{ t('share.invitation.failed') }}</p>
            <p class="text-xs text-surface-400 mt-1">{{ error.message }}</p>
          </div>
        </div>
        <BaseBadge variant="error">{{ error.code }}</BaseBadge>
      </div>

      <div v-else class="rounded-2xl border border-surface-700/40 bg-surface-900/40 p-5 space-y-4">
        <p class="text-sm text-surface-300">{{ t('share.invitation.ready') }}</p>
        <p class="text-xs text-surface-500">{{ t('share.invitation.emailMatch') }}</p>
        <BaseButton :loading="accepting" @click="accept">{{ t('share.invitation.accept') }}</BaseButton>
      </div>
    </div>
  </AppLayout>
</template>
