import type { ReactNode } from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { PageLoader } from '@/components/page-loader';
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
  const { t } = useSetupTexts();
  const status = useSalesTaxSetupGate();

  if (status === 'loading') return <PageLoader fullScreen={false} />;
  if (status === 'load-error') {
    return (
      <Alert variant="destructive" className="m-4 sm:m-6 w-auto">
        <AlertDescription>{t.common.loadError}</AlertDescription>
      </Alert>
    );
  }
  if (status === 'us-only') {
    return <p className="p-6 text-sm text-muted-foreground">{t.common.usOnly}</p>;
  }
  if (status === 'no-access') {
    return <p className="p-6 text-sm text-muted-foreground">{t.common.noAccess}</p>;
  }
  return <>{children}</>;
}
