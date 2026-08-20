import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { formatWeldbooksMoney } from '@/lib/weldbooks/format-money';

export interface AccountingEntityCurrencyRow {
  id: string;
  baseCurrency: string;
  locale?: string | null;
  isDefault?: boolean | null;
}

export function accountingEntitiesQueryKey(workspaceId: string | null | undefined) {
  return ['accounting', 'entities', workspaceId ?? null] as const;
}

/**
 * Currency + locale of the currently selected WeldBooks legal entity.
 * Shares the `['accounting', 'entities', workspaceId]` query with the entity switcher.
 */
export function useCurrentEntityCurrency() {
  const { entityId } = useCurrentAccountingEntity();
  const workspaceId = useWorkspaceId();
  const { data: entities = [] } = useQuery<AccountingEntityCurrencyRow[]>({
    queryKey: accountingEntitiesQueryKey(workspaceId),
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

  const entityCurrency = current?.baseCurrency ?? null;
  const currency = entityCurrency || 'EUR';
  const locale = current?.locale || 'nl-NL';

  const formatMoney = useCallback(
    (value: number | string | null | undefined, overrideCurrency?: string | null) =>
      formatWeldbooksMoney(value, overrideCurrency ?? currency, locale),
    [currency, locale],
  );

  return { currency, entityCurrency, locale, formatMoney, entity: current };
}
