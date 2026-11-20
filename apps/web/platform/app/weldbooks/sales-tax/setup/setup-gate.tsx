import type { ReactNode } from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import { JurisdictionGate } from '@/components/accounting/jurisdiction-gate';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useSetupTexts } from './setup-texts';

/** What the signed-in member may do with the sales tax setup of the selected entity. */
export function useSalesTaxSetupAccess() {
  const { can } = usePermissions();
  const { features, isResolved, isError } = useCurrentJurisdiction();
  return {
    isResolved,
    isError,
    isUs: features.salesTax,
    canRead: can('taxes:read'),
    canCreate: can('taxes:create'),
    canUpdate: can('taxes:update'),
    canDelete: can('taxes:delete'),
  };
}

export type SalesTaxSetupGateStatus = 'loading' | 'load-error' | 'us-only' | 'no-access' | 'ready';

/**
 * Where a setup screen stands: waiting for the entity's jurisdiction, or ready
 * only for a US entity and a member who can read taxes. `SalesTaxSetupGate`
 * wraps pages in it; the sales tax record panels read it themselves.
 */
export function useSalesTaxSetupGate(): SalesTaxSetupGateStatus {
  const access = useSalesTaxSetupAccess();
  if (!access.isResolved && !access.isError) return 'loading';
  if (access.isError && !access.isResolved) return 'load-error';
  if (!access.isUs) return 'us-only';
  if (!access.canRead) return 'no-access';
  return 'ready';
}

/**
 * Wraps a setup screen: waits for the entity's jurisdiction, then shows the
 * screen only for a US entity and a member who can read taxes.
 */
export function SalesTaxSetupGate({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  return (
    <JurisdictionGate when={(j) => j.features.salesTax} feature={t.accounting.header.salesTax}>
      <SalesTaxReadAccess>{children}</SalesTaxReadAccess>
    </JurisdictionGate>
  );
}

/** The permission half of the gate, inside the jurisdiction check. */
function SalesTaxReadAccess({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useSetupTexts();
  const { can } = usePermissions();
  if (!can('taxes:read')) {
    return <p className="p-6 text-sm text-muted-foreground">{t.common.noAccess}</p>;
  }
  return <>{children}</>;
}
