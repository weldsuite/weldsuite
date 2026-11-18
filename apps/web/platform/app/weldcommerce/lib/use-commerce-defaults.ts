/**
 * Workspace defaults the commerce forms start from, read off the workspace's
 * legal entities (Settings → Legal entities), so an NL/EUR workspace gets EUR
 * prices and no US sales tax fields.
 *
 * - `currency`: the default entity's base currency, for a new product or
 *   order. Null until the entities are known or when there are none; the
 *   forms then leave the currency to the person (or the API's default).
 * - `salesTax`: whether any entity is in the US. Product tax codes only feed
 *   the US sales tax engine (WeldBooks invoices and order tax both run only
 *   for a US entity), so the product form shows them only then.
 */

import { useMemo } from 'react';
import { useLegalEntities } from '@/hooks/queries/use-legal-entities-queries';
import { fallbackLegalEntity } from '@/hooks/use-current-legal-entity';

export function useCommerceDefaults() {
  const { data: entities, isLoading } = useLegalEntities();
  return useMemo(() => {
    const list = entities ?? [];
    const entity = fallbackLegalEntity(list);
    const currency = entity?.baseCurrency?.trim().toUpperCase() || null;
    const salesTax = list.some((e) => e.jurisdictionCode?.toUpperCase() === 'US');
    return { currency, salesTax, isLoading };
  }, [entities, isLoading]);
}
