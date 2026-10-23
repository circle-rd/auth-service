import {
  ArrowRightLeft,
  CirclePlus,
  Gift,
  Infinity as InfinityIcon,
  PackageMinus,
  PackagePlus,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
} from 'lucide-vue-next';
import type { Component } from 'vue';
import type { JournalKind } from '@/types/accounting';

type BadgeVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary';

export const JOURNAL_KIND_META: Record<JournalKind, { icon: Component; variant: BadgeVariant }> = {
  topup: { icon: CirclePlus, variant: 'success' },
  grant: { icon: Gift, variant: 'info' },
  refund: { icon: Undo2, variant: 'warning' },
  adjust: { icon: SlidersHorizontal, variant: 'neutral' },
  reversal: { icon: RotateCcw, variant: 'error' },
  unlimited_enabled: { icon: InfinityIcon, variant: 'info' },
  unlimited_disabled: { icon: InfinityIcon, variant: 'neutral' },
  subscription_assigned: { icon: PackagePlus, variant: 'primary' },
  subscription_changed: { icon: ArrowRightLeft, variant: 'primary' },
  subscription_removed: { icon: PackageMinus, variant: 'warning' },
};

export function isPlanKind(kind: JournalKind): boolean {
  return kind.startsWith('subscription_');
}
