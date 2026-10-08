import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import { formatWeldbooksMoney } from '@/lib/weldbooks/format-money';

/** The fields of an entity row the currency/locale helpers read. */
export type AccountingEntityCurrencyRow = Pick<AccountingEntity, 'id' | 'baseCurrency'> &
  Partial<AccountingEntity>;

export function accountingEntitiesQueryKey(workspaceId: string | null | undefined) {
  return ['accounting', 'entities', workspaceId ?? null] as const;
}

/**
 * Every accounting entity of the workspace. Shares the
 * `['accounting', 'entities', workspaceId]` query with the entity switcher
 * and the WeldBooks layout.
 */
export function useAccountingEntities(options: { enabled?: boolean } = {}) {
  const workspaceId = useWorkspaceId();
  return useQuery<AccountingEntityCurrencyRow[]>({
    queryKey: accountingEntitiesQueryKey(workspaceId),
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const res = await weldbooksApi.get<
        { data: AccountingEntityCurrencyRow[] } | AccountingEntityCurrencyRow[]
      >('/accounting-entities');
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });
}

/**
 * The selected entity's row from the entities list, falling back to the
 * workspace default (or the first entity) while nothing is selected.
 */
export function useCurrentAccountingEntityRow(options: { enabled?: boolean } = {}) {
  const { entityId } = useCurrentAccountingEntity();
  const query = useAccountingEntities(options);
  const entities = query.data ?? [];
  const entity =
    entities.find((e) => e.id === entityId) ??
    entities.find((e) => e.isDefault) ??
    entities[0];
  return { entity, entities, isLoading: query.isLoading, isError: query.isError };
}

/**
 * Currency + locale of the currently selected WeldBooks legal entity.
 *
 * `currency` and `locale` are empty strings until the entity is known; the
 * money formatter then shows a plain amount rather than assuming a currency.
 */
export function useCurrentEntityCurrency() {
  const { entity: current } = useCurrentAccountingEntityRow();

  const entityCurrency = current?.baseCurrency || null;
  const currency = entityCurrency ?? '';
  const locale = current?.locale || '';

  const formatMoney = useCallback(
    (value: number | string | null | undefined, overrideCurrency?: string | null) =>
      formatWeldbooksMoney(value, overrideCurrency || currency, locale),
    [currency, locale],
  );

  return { currency, entityCurrency, locale, formatMoney, entity: current };
}
