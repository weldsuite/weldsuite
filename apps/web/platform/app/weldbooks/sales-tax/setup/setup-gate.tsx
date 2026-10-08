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

/**
 * Wraps a setup screen: waits for the entity's jurisdiction, then shows the
 * screen only for a US entity and a member who can read taxes.
 */
export function SalesTaxSetupGate({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useSetupTexts();
  const access = useSalesTaxSetupAccess();

  if (!access.isResolved && !access.isError) return <PageLoader fullScreen={false} />;
  if (access.isError && !access.isResolved) {
    return (
      <Alert variant="destructive" className="m-4 sm:m-6 w-auto">
        <AlertDescription>{t.common.loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!access.isUs) {
    return <p className="p-6 text-sm text-muted-foreground">{t.common.usOnly}</p>;
  }
  if (!access.canRead) {
    return <p className="p-6 text-sm text-muted-foreground">{t.common.noAccess}</p>;
  }
  return <>{children}</>;
}
