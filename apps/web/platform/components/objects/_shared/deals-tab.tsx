/**
 * `DealsTab` — Pipeline tab for the company / person object panels.
 *
 * Thin adapter over the legacy `DealsSection` from `customer-detail/`.
 * Company side uses `useCustomerDeals(customerId)`; person side uses
 * `usePersonDeals(personId)` which is backed by a `personId` filter on
 * the `/opportunities` route doing JSONB containment on `personIds`.
 */

import { useTranslations } from '@weldsuite/i18n/client';
import {
  useCustomerDeals,
  usePersonDeals,
} from '@/hooks/queries/use-customer-deals-queries';
import { DealsSection } from '@/components/customer-detail/sections/deals-section';
import type { Customer, Opportunity } from '@/components/customer-detail/types';

interface DealsTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function DealsTab({ entityId, entityKind }: DealsTabProps) {
  const t = useTranslations();
  const companyQuery = useCustomerDeals(entityId, entityKind === 'company');
  const personQuery = usePersonDeals(entityId, entityKind === 'person');
  const { data, isLoading } = entityKind === 'company' ? companyQuery : personQuery;

  if (isLoading) {
    return (
      <div className="px-3 py-6 text-sm text-muted-foreground text-center">
        {t('sweep.entities.loadingDeals')}
      </div>
    );
  }

  const opportunities = (data?.data ?? []) as Opportunity[];

  return (
    <DealsSection
      customer={{ id: entityId } as Customer}
      opportunities={opportunities}
      totalCount={opportunities.length}
    />
  );
}
