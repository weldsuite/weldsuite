/**
 * `DealsTab` — Deals tab for the company / person object panels.
 *
 * Thin adapter over `DealsSection` (the deals list) from `customer-detail/`.
 * Company side uses `useCustomerDeals(customerId)`; person side uses
 * `usePersonDeals(personId)` which is backed by a `personId` filter on
 * the `/opportunities` route doing JSONB containment on `personIds`.
 */

import { useMemo } from 'react';
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

export function DealsTab({ entityId, entityKind }: Readonly<DealsTabProps>) {
  const companyQuery = useCustomerDeals(entityId, entityKind === 'company');
  const personQuery = usePersonDeals(entityId, entityKind === 'person');
  const { data, isLoading } = entityKind === 'company' ? companyQuery : personQuery;

  const opportunities = useMemo(() => (data?.data ?? []) as Opportunity[], [data]);

  return (
    <DealsSection
      customer={{ id: entityId } as Customer}
      opportunities={opportunities}
      totalCount={opportunities.length}
      entityKind={entityKind}
      isLoading={isLoading}
    />
  );
}
