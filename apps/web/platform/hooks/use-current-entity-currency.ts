import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { formatWeldbooksMoney } from '@/lib/weldbooks/format-money';

export interface AccountingEntityCurrencyRow {
  id: string;
  baseCurrency: string;
  locale?: string | null;
  isDefault?: boolean | null;
}

/**
 * Currency + locale of the currently selected WeldBooks legal entity.
 * Shares the `['accounting', 'entities']` query with the entity switcher.
 */
export function useCurrentEntityCurrency() {
  const { entityId } = useCurrentAccountingEntity();
  const { data: entities = [] } = useQuery<AccountingEntityCurrencyRow[]>({
    queryKey: ['accounting', 'entities'],
    queryFn: async () => {
      const res = await weldbooksApi.get<
        { data: AccountingEntityCurrencyRow[] } | AccountingEntityCurrencyRow[]
      >('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const current =
    entities.find((e) => e.id === entityId) ??
    entities.find((e) => e.isDefault) ??
    entities[0];

  const currency = current?.baseCurrency || 'EUR';
  const locale = current?.locale || 'nl-NL';

  const formatMoney = useCallback(
    (value: number | string | null | undefined, overrideCurrency?: string | null) =>
      formatWeldbooksMoney(value, overrideCurrency ?? currency, locale),
    [currency, locale],
  );

  return { currency, locale, formatMoney, entity: current };
}
