<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServicesStore } from '@/stores/services';
import { listUsers } from '@/api/users';
import { listApplications } from '@/api/applications';
import { listOrganizations } from '@/api/organizations';
import { getBillingStats, type BillingStats } from '@/api/stats';
import type { User } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import Sparkline from '@/components/ui/Sparkline.vue';
import { CheckCircle, XCircle, CreditCard, ShieldCheck, Lock, Users, AppWindow, Building2, ArrowRightLeft } from '@lucide/vue';

const { t, locale } = useI18n();
const services = useServicesStore();

const users = ref<User[]>([]);
const appCount = ref(0);
const orgCount = ref(0);
const loading = ref(true);
const billingStats = ref<BillingStats | null>(null);
const billingLoading = ref(false);
const billingError = ref(false);
const billingRange = ref<'7d' | '30d'>('30d');

onMounted(async () => {
  await Promise.all([
    services.fetch(),
    (async () => {
      const [u, a, o] = await Promise.all([listUsers({ limit: 200 }), listApplications(), listOrganizations()]);
      users.value = u.users;
      appCount.value = a.applications.length;
      orgCount.value = o.organizations.length;
    })(),
  ]);
  loading.value = false;
  if (services.config?.stripe) await loadBillingStats();
});

async function loadBillingStats() {
  billingLoading.value = true;
  billingError.value = false;
  try {
    billingStats.value = await getBillingStats({ range: billingRange.value });
  } catch {
    billingError.value = true;
  } finally {
    billingLoading.value = false;
  }
}

async function setBillingRange(range: '7d' | '30d') {
  if (billingRange.value === range) return;
  billingRange.value = range;
  await loadBillingStats();
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(locale.value, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale.value).format(value);
}

function relativeTime(iso: string | null): string {
  if (!iso) return t('configuration.billingStats.never');
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t('configuration.billingStats.justNow');
  if (minutes < 60) return t('configuration.billingStats.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('configuration.billingStats.hoursAgo', { n: hours });
  return t('configuration.billingStats.daysAgo', { n: Math.floor(hours / 24) });
}

const topPlans = computed(() => {
  const plans = billingStats.value?.subscriptions.byPlan.slice(0, 4) ?? [];
  const max = Math.max(...plans.map((p) => p.count), 1);
  return plans.map((p) => ({ ...p, percent: Math.round((p.count / max) * 100) }));
});

const mfaRate = computed(() => {
  if (!users.value.length) return 0;
  return Math.round((users.value.filter(u => u.twoFactorEnabled).length / users.value.length) * 100);
});

const mfaForcedCount = computed(() => users.value.filter(u => u.isMfaRequired).length);

const PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;

function maskId(id: string | undefined) {
  if (!id) return '';
  return id.slice(0, 6) + '••••••••' + id.slice(-4);
}

type ProviderKey = typeof PROVIDERS[number];

function getProvider(key: ProviderKey) {
  return services.config?.providers[key];
}
</script>

<template>
  <AppLayout :title="t('configuration.title')" :subtitle="t('configuration.subtitle')">
    <div class="space-y-6">

      <!-- Row 1: MFA + Platform Info -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
              <ShieldCheck class="w-4 h-4 text-primary-400" />
            </div>
            <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.mfa') }}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p class="text-xs text-surface-500 mb-1">{{ t('configuration.mfaAdoption') }}</p>
              <p class="text-2xl font-bold text-surface-100">{{ mfaRate }}%</p>
              <div class="mt-2 h-1.5 bg-surface-800 rounded-full overflow-hidden">
                <div class="h-full bg-primary-500 rounded-full transition-all duration-500" :style="{ width: `${mfaRate}%` }" />
              </div>
            </div>
            <div>
              <p class="text-xs text-surface-500 mb-1">{{ t('configuration.mfaForced') }}</p>
              <p class="text-2xl font-bold text-surface-100">{{ mfaForcedCount }}</p>
            </div>
          </div>
        </div>

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center">
              <Lock class="w-4 h-4 text-surface-400" />
            </div>
            <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.platformInfo') }}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div class="text-center">
              <div class="w-10 h-10 rounded-xl bg-primary-500/10 flex items-center justify-center mx-auto mb-2">
                <Users class="w-5 h-5 text-primary-400" />
              </div>
              <p class="text-xl font-bold text-surface-100">{{ users.length }}</p>
              <p class="text-xs text-surface-500">{{ t('nav.users') }}</p>
            </div>
            <div class="text-center">
              <div class="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-2">
                <AppWindow class="w-5 h-5 text-emerald-400" />
              </div>
              <p class="text-xl font-bold text-surface-100">{{ appCount }}</p>
              <p class="text-xs text-surface-500">{{ t('nav.applications') }}</p>
            </div>
            <div class="text-center">
              <div class="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center mx-auto mb-2">
                <Building2 class="w-5 h-5 text-amber-400" />
              </div>
              <p class="text-xl font-bold text-surface-100">{{ orgCount }}</p>
              <p class="text-xs text-surface-500">{{ t('nav.organizations') }}</p>
            </div>
          </div>
        </div>

      </div>

      <!-- Row 2: Auth Providers + Billing -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
          <div class="px-5 py-4 border-b border-surface-700/40">
            <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.providers') }}</h2>
          </div>
          <div class="divide-y divide-surface-800/40">
            <div v-for="key in PROVIDERS" :key="key" class="px-5 py-4 flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div :class="['w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold', getProvider(key)?.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface-800 text-surface-500']">
                  {{ key[0].toUpperCase() }}
                </div>
                <div>
                  <p class="text-sm font-medium text-surface-200 capitalize">{{ key }}</p>
                  <p v-if="getProvider(key)?.enabled && getProvider(key)?.clientId" class="text-xs font-mono text-surface-500 mt-0.5">
                    {{ maskId(getProvider(key)?.clientId) }}
                  </p>
                </div>
              </div>
              <BaseBadge :variant="getProvider(key)?.enabled ? 'success' : 'neutral'" dot>
                {{ getProvider(key)?.enabled ? t('common.enabled') : t('common.disabled') }}
              </BaseBadge>
            </div>
          </div>
        </div>

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <div class="flex items-center gap-3 mb-3">
            <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <CreditCard class="w-4 h-4 text-emerald-400" />
            </div>
            <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.billing') }}</h2>
          </div>
          <div v-if="loading" class="h-8 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-lg w-32" />
          <template v-else>
            <div class="flex items-center gap-2 mb-2">
              <CheckCircle v-if="services.config?.stripe" class="w-4 h-4 text-emerald-400" />
              <XCircle v-else class="w-4 h-4 text-surface-600" />
              <p class="text-sm font-medium" :class="services.config?.stripe ? 'text-emerald-400' : 'text-surface-400'">
                {{ services.config?.stripe ? t('configuration.stripeActive') : t('configuration.stripeInactive') }}
              </p>
            </div>
            <p v-if="!services.config?.stripe" class="text-xs text-surface-500">{{ t('configuration.stripeInactiveNote') }}</p>

            <template v-else>
              <p v-if="billingLoading" class="text-xs text-surface-500 mt-3">{{ t('configuration.billingStats.loading') }}</p>
              <div v-else-if="billingError" class="mt-3 flex items-center gap-2">
                <p class="text-xs text-surface-500">{{ t('configuration.billingStats.error') }}</p>
                <button
                  type="button"
                  class="text-xs font-medium text-primary-400 hover:text-primary-300"
                  @click="loadBillingStats"
                >{{ t('configuration.billingStats.retry') }}</button>
              </div>
              <template v-else-if="billingStats">
                <div class="grid grid-cols-2 gap-3 mt-4">
                  <div>
                    <p class="text-xs text-surface-500 mb-1">{{ t('configuration.billingStats.revenue') }}</p>
                    <p class="text-lg font-bold text-surface-100 tabular-nums">{{ formatMoney(billingStats.revenue.total, billingStats.currency) }}</p>
                    <p class="text-[11px] text-surface-500">{{ t('configuration.billingStats.revenueSub', { n: formatNumber(billingStats.revenue.count) }) }}</p>
                  </div>
                  <div>
                    <p class="text-xs text-surface-500 mb-1">{{ t('configuration.billingStats.activeSubscriptions') }}</p>
                    <p class="text-lg font-bold text-surface-100 tabular-nums">{{ formatNumber(billingStats.subscriptions.active) }}</p>
                    <p class="text-[11px] text-surface-500">
                      {{ t('configuration.billingStats.activeSubscriptionsSub', {
                        stripe: formatNumber(billingStats.subscriptions.stripeManaged),
                        cancel: formatNumber(billingStats.subscriptions.cancelAtPeriodEnd),
                      }) }}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs text-surface-500 mb-1">{{ t('configuration.billingStats.customers') }}</p>
                    <p class="text-lg font-bold text-surface-100 tabular-nums">{{ formatNumber(billingStats.customers.withStripe) }}</p>
                    <p class="text-[11px] text-surface-500">
                      {{ t('configuration.billingStats.customersSub', {
                        stripe: formatNumber(billingStats.customers.withStripe),
                        users: formatNumber(billingStats.customers.users),
                      }) }}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs text-surface-500 mb-1">{{ t('configuration.billingStats.openInvoices') }}</p>
                    <p class="text-lg font-bold text-surface-100 tabular-nums">{{ formatNumber(billingStats.invoices.openCount) }}</p>
                    <p class="text-[11px] text-surface-500">
                      {{ t('configuration.billingStats.openInvoicesSub', {
                        amount: formatMoney(billingStats.invoices.openAmount, billingStats.currency),
                      }) }}
                    </p>
                  </div>
                </div>

                <div class="mt-3 flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <span class="text-[11px] text-surface-500">{{ t('configuration.billingStats.revenueWindow') }}</span>
                    <div class="flex items-center gap-0.5 rounded-md bg-surface-800/70 p-0.5">
                      <button
                        v-for="range in (['7d', '30d'] as const)"
                        :key="range"
                        type="button"
                        :class="[
                          billingRange === range ? 'bg-surface-700 text-surface-100' : 'text-surface-500 hover:text-surface-300',
                          'px-2 py-0.5 rounded text-[11px] tabular-nums transition-colors',
                        ]"
                        @click="setBillingRange(range)"
                      >{{ range === '7d' ? t('configuration.billingStats.range7d') : t('configuration.billingStats.range30d') }}</button>
                    </div>
                  </div>
                  <Sparkline
                    :values="billingStats.revenue.series.map((p) => p.amount)"
                    :width="180"
                    :height="30"
                  />
                </div>
                <p v-if="billingStats.revenue.byCurrency.length > 1" class="text-[11px] text-surface-500 mt-1">
                  {{ t('configuration.billingStats.multiCurrency', { currency: billingStats.currency.toUpperCase() }) }}
                </p>

                <div class="mt-4">
                  <p class="text-xs text-surface-500 mb-2">{{ t('configuration.billingStats.byPlan') }}</p>
                  <div v-if="topPlans.length" class="space-y-1.5">
                    <div v-for="plan in topPlans" :key="plan.planId">
                      <div class="flex items-center justify-between gap-2 text-[11px] text-surface-400 mb-0.5">
                        <span class="truncate">
                          {{ plan.planName }}<span class="text-surface-600"> · {{ plan.applicationName }}</span>
                        </span>
                        <span class="tabular-nums shrink-0">{{ formatNumber(plan.count) }}</span>
                      </div>
                      <div class="h-1 bg-surface-800 rounded-full overflow-hidden">
                        <div class="h-full bg-emerald-500/70 rounded-full" :style="{ width: `${plan.percent}%` }" />
                      </div>
                    </div>
                  </div>
                  <p v-else class="text-xs text-surface-500">{{ t('configuration.billingStats.noPlans') }}</p>
                </div>

                <div class="mt-4 pt-3 border-t border-surface-800/60 text-[11px] text-surface-500 space-y-1">
                  <p>
                    {{ t('configuration.billingStats.catalogCoverage') }}:
                    {{ t('configuration.billingStats.plansLinked', {
                      linked: formatNumber(billingStats.catalog.plansLinked),
                      total: formatNumber(billingStats.catalog.plans),
                    }) }} ·
                    {{ t('configuration.billingStats.pricesLinked', {
                      linked: formatNumber(billingStats.catalog.pricesLinked),
                      total: formatNumber(billingStats.catalog.prices),
                    }) }} ·
                    {{ t('configuration.billingStats.metersLinked', { n: formatNumber(billingStats.catalog.metersLinked) }) }}
                  </p>
                  <p>
                    {{ t('configuration.billingStats.lastEvent', { time: relativeTime(billingStats.webhooks.lastProcessedAt) }) }} ·
                    {{ t('configuration.billingStats.events24h', { n: formatNumber(billingStats.webhooks.last24h) }) }}
                  </p>
                </div>
              </template>
            </template>
          </template>
        </div>

      </div>

      <!-- Row 3: identity provider compatibility -->
      <div v-if="services.config?.compat" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <div class="flex items-center gap-3 mb-1">
          <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
            <ArrowRightLeft class="w-4 h-4 text-primary-400" />
          </div>
          <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.compat') }}</h2>
          <BaseBadge variant="neutral" class="uppercase">{{ services.config.compat.profile }}</BaseBadge>
        </div>
        <p class="text-xs text-surface-500 mb-4 ml-11">{{ t('configuration.compatNote') }}</p>
        <dl class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div>
            <dt class="text-xs text-surface-500 mb-1">{{ t('configuration.compatTokenAuth') }}</dt>
            <dd class="text-surface-200">
              {{ services.config.compat.tokenAuthMethod === 'post' ? t('configuration.compatTokenAuthPost') : t('configuration.compatTokenAuthBasic') }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-surface-500 mb-1">{{ t('configuration.compatSigning') }}</dt>
            <dd class="font-mono text-surface-200">{{ services.config.compat.signingAlg }}</dd>
          </div>
          <div>
            <dt class="text-xs text-surface-500 mb-1">{{ t('configuration.compatDefaultAudience') }}</dt>
            <dd>
              <BaseBadge :variant="services.config.compat.defaultAudience ? 'success' : 'neutral'" dot>
                {{ services.config.compat.defaultAudience ? t('common.enabled') : t('common.disabled') }}
              </BaseBadge>
            </dd>
          </div>
          <div>
            <dt class="text-xs text-surface-500 mb-1">{{ t('configuration.compatAudienceParam') }}</dt>
            <dd>
              <BaseBadge :variant="services.config.compat.audienceParam ? 'success' : 'neutral'" dot>
                {{ services.config.compat.audienceParam ? t('common.enabled') : t('common.disabled') }}
              </BaseBadge>
            </dd>
          </div>
        </dl>
        <div class="mt-4">
          <p class="text-xs text-surface-500 mb-2">{{ t('configuration.compatClaims') }}</p>
          <div v-if="services.config.compat.claimMappings.length" class="flex flex-wrap gap-2">
            <span
              v-for="m in services.config.compat.claimMappings"
              :key="m.claim"
              class="px-2 py-1 rounded-md bg-surface-800 text-xs font-mono text-surface-300"
            >{{ m.claim }} ← {{ m.source }}<template v-if="m.scope"> ({{ m.scope }})</template></span>
          </div>
          <p v-else class="text-xs text-surface-400">{{ t('configuration.compatNoClaims') }}</p>
        </div>
      </div>

    </div>
  </AppLayout>
</template>
