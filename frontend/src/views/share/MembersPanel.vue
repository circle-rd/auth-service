<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { UserPlus } from '@lucide/vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import { addOwnerMember, listOwnerMembers, type OwnerMember } from '@/api/resources';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();

const members = ref<OwnerMember[]>([]);
const loading = ref(true);
const adding = ref(false);
const showForm = ref(false);
const email = ref('');

async function load() {
  loading.value = true;
  try {
    members.value = (await listOwnerMembers(props.appId)).members;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  email.value = '';
  showForm.value = true;
}

async function add() {
  if (!email.value.trim()) return;
  adding.value = true;
  try {
    const result = await addOwnerMember(props.appId, email.value.trim());
    toast.success(
      result.member.created ? t('share.members.added') : t('share.members.alreadyMember'),
    );
    showForm.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.members.addError'));
  } finally {
    adding.value = false;
  }
}

watch(() => props.appId, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-sm text-surface-400">{{ t('share.members.hint') }}</p>
      <BaseButton size="sm" @click="openAdd">
        <UserPlus class="w-3.5 h-3.5" />{{ t('share.members.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="members.length === 0"
      :title="t('share.members.empty')"
      :message="t('share.members.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.members.name') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.members.email') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.members.roles') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in members" :key="member.userId" class="border-t border-surface-800/60">
            <td class="px-4 py-3 text-surface-200">{{ member.name }}</td>
            <td class="px-4 py-3 text-surface-300">{{ member.email }}</td>
            <td class="px-4 py-3 text-surface-400">{{ member.roles.join(', ') || '—' }}</td>
            <td class="px-4 py-3">
              <BaseBadge :variant="member.isActive ? 'success' : 'neutral'" dot>
                {{ member.isActive ? t('common.active') : t('common.inactive') }}
              </BaseBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <BaseModal :open="showForm" :title="t('share.members.addTitle')" size="sm" @close="showForm = false">
      <div class="space-y-3">
        <BaseInput v-model="email" type="email" :label="t('share.members.email')" required />
        <p class="text-xs text-surface-500">{{ t('share.members.addHint') }}</p>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="adding" :disabled="!email.trim()" @click="add">
          {{ t('share.members.add') }}
        </BaseButton>
      </template>
    </BaseModal>
  </div>
</template>
