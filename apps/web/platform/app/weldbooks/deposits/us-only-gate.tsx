import type { ReactNode } from 'react';
import { JurisdictionGate } from '@/components/accounting/jurisdiction-gate';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';

/**
 * Undeposited Funds and deposits are a US practice: an entity of another
 * country gets a notice instead of the screen (and its data is never fetched).
 */
export function DepositsUsOnlyGate({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  return (
    <JurisdictionGate when={(j) => isUsJurisdictionCode(j.code)} feature={t.accounting.header.deposits}>
      {children}
    </JurisdictionGate>
  );
}
