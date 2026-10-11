import { useI18n } from 'vue-i18n';
import { formatMicroEur } from '@/utils/money';

/** Money formatting bound to the active locale. */
export function useMoney() {
  const { locale } = useI18n();
  return {
    fmt: (micro: string | bigint): string => formatMicroEur(micro, locale.value),
  };
}
