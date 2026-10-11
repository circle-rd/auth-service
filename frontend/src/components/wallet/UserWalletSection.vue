<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import WalletBalanceCard from '@/components/wallet/WalletBalanceCard.vue';
import WalletSpendCard from '@/components/wallet/WalletSpendCard.vue';
import WalletTransactionList from '@/components/wallet/WalletTransactionList.vue';
import WalletActionModal from '@/components/wallet/WalletActionModal.vue';
import type { WalletActionMode } from '@/components/wallet/WalletActionModal.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import { getUserSpendStatsAdmin, getUserTransactions, getUserWallet, setUnlimited } from '@/api/wallet';
import { useAdminEvents } from '@/composables/useAdminEvents';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useWalletData } from '@/composables/useWalletData';

const props = defineProps<{ userId: string }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const { account, stats, items, nextCursor, loading, loadingMore, refresh, loadMore } = useWalletData({
  getAccount: () => getUserWallet(props.userId),
  getStats: (days) => getUserSpendStatsAdmin(props.userId, days),
  getPage: (params) => getUserTransactions(props.userId, params),
});

const actionMode = ref<WalletActionMode | null>(null);
const unlimitedOpen = ref(false);
const unlimitedReason = ref('');
const unlimitedSaving = ref(false);

const events = useAdminEvents({ 'wallet.changed': () => void refresh() });

async function toggleUnlimited(): Promise<void> {
  if (!account.value || unlimitedReason.value.trim() === '') return;
  unlimitedSaving.value = true;
  try {
    await setUnlimited(props.userId, {
      isUnlimited: !account.value.isUnlimited,
      reason: unlimitedReason.value.trim(),
    });
    toast.success(t('wallet.admin.unlimitedChanged'));
    unlimitedOpen.value = false;
    unlimitedReason.value = '';
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('wallet.admin.error'));
  } finally {
    unlimitedSaving.value = false;
  }
}

onMounted(() => void refresh());
onUnmounted(() => events.close());
</script>

<template>
  <section class="space-y-5" data-testid="user-wallet-section">
    <h3 class="text-sm font-semibold text-surface-200">{{ t('wallet.admin.sectionTitle') }}</h3>

    <div class="grid lg:grid-cols-2 gap-5">
      <WalletBalanceCard :account="account" :loading="loading">
        <template v-if="auth.isSuperAdmin()" #actions>
          <BaseButton size="sm" @click="actionMode = 'topup'">{{ t('wallet.admin.actions.topup') }}</BaseButton>
          <BaseButton size="sm" variant="secondary" @click="actionMode = 'grant'">{{ t('wallet.admin.actions.grant') }}</BaseButton>
          <BaseButton size="sm" variant="outline" @click="actionMode = 'adjust'">{{ t('wallet.admin.actions.adjust') }}</BaseButton>
        </template>
      </WalletBalanceCard>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6">
        <BaseToggle
          :model-value="account?.isUnlimited ?? false"
          :label="t('wallet.admin.unlimitedToggle')"
          :description="t('wallet.admin.unlimitedDesc')"
          :disabled="!auth.isSuperAdmin() || !account"
          @update:model-value="unlimitedOpen = true"
        />
        <p v-if="!auth.isSuperAdmin()" class="mt-4 text-xs text-surface-500">{{ t('wallet.admin.readOnly') }}</p>
      </div>
    </div>

    <WalletSpendCard :stats="stats" :loading="loading" />

    <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
      <div class="px-5 py-4 border-b border-surface-700/40">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('wallet.history.title') }}</h3>
      </div>
      <WalletTransactionList
        :items="items"
        :loading="loading"
        :has-more="nextCursor !== null"
        :loading-more="loadingMore"
        @load-more="loadMore"
      />
    </div>

    <WalletActionModal
      v-if="actionMode"
      :open="true"
      :user-id="userId"
      :mode="actionMode"
      @close="actionMode = null"
      @done="refresh"
    />

    <BaseModal :open="unlimitedOpen" :title="t('wallet.admin.actions.unlimited')" size="sm" @close="unlimitedOpen = false">
      <form class="space-y-4" @submit.prevent="toggleUnlimited">
        <p class="text-sm text-surface-400">{{ t('wallet.admin.unlimitedDesc') }}</p>
        <BaseInput v-model="unlimitedReason" :label="t('wallet.admin.form.reason')" :hint="t('wallet.admin.form.reasonHint')" required />
        <div class="flex justify-end gap-2 pt-2">
          <BaseButton variant="ghost" @click="unlimitedOpen = false">{{ t('common.cancel') }}</BaseButton>
          <BaseButton type="submit" :loading="unlimitedSaving" :disabled="unlimitedReason.trim() === ''">
            {{ t('wallet.admin.form.submit') }}
          </BaseButton>
        </div>
      </form>
    </BaseModal>
  </section>
</template>
