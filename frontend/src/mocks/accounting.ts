import type { JournalEntry } from '@/types/accounting';

/** Development fixtures (VITE_USE_MOCK=true): amounts in micro-euros. */

const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

const alice = { type: 'user', id: 'usr_alice', name: 'Alice Martin', email: 'alice@example.com' } as const;
const bob = { type: 'user', id: 'usr_bob', name: 'Bob Durand', email: 'bob@example.com' } as const;
const admin = { id: 'usr_admin', name: 'Superadmin', email: 'admin@example.com' };
const app = { id: 'app_chat', name: 'Chat', slug: 'chat' };

export const MOCK_JOURNAL: JournalEntry[] = [
  {
    id: 'sub:1', kind: 'subscription_changed', createdAt: ago(1), owner: bob, actor: admin, source: 'admin',
    application: app, amount: null, balanceAfter: null, fromPlan: 'free', toPlan: 'pro', reason: 'Upgrade requested by support', reference: null,
  },
  {
    id: 'tx:1', kind: 'topup', createdAt: ago(5), owner: alice, actor: null, source: 'stripe',
    application: null, amount: '20000000', balanceAfter: '24500000', fromPlan: null, toPlan: null, reason: null, reference: null,
  },
  {
    id: 'tx:2', kind: 'grant', createdAt: ago(30), owner: bob, actor: admin, source: null,
    application: null, amount: '5000000', balanceAfter: '5000000', fromPlan: null, toPlan: null, reason: 'Compensation for the outage', reference: null,
  },
  {
    id: 'evt:1', kind: 'unlimited_enabled', createdAt: ago(52), owner: alice, actor: admin, source: 'admin',
    application: null, amount: null, balanceAfter: null, fromPlan: null, toPlan: null, reason: 'Internal account', reference: null,
  },
  {
    id: 'tx:3', kind: 'topup', createdAt: ago(80), owner: bob, actor: admin, source: 'manual',
    application: null, amount: '100000000', balanceAfter: '100000000', fromPlan: null, toPlan: null, reason: null, reference: 'INV-2026-0042',
  },
  {
    id: 'sub:2', kind: 'subscription_assigned', createdAt: ago(120), owner: alice, actor: null, source: 'default',
    application: app, amount: null, balanceAfter: null, fromPlan: null, toPlan: 'free', reason: null, reference: null,
  },
];
