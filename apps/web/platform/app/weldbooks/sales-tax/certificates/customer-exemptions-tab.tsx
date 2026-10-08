import { Link } from '@tanstack/react-router';
import { FileCheck2, Plus } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useExemptionCertificates } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { useSetupTexts } from '../setup/setup-texts';
import { CertificatesTable } from './certificates-table';

export interface CustomerExemptionsTabProps {
  partyId: string;
  /** The customer's default use (`business` or `personal`); edited on the contact form, shown here. */
  taxUse?: string | null;
}

/**
 * The customer page's Exemptions tab: the customer's certificates with status,
 * states and expiry, and a way to add one. The customer's default use (business
 * or personal) is edited on the contact form; it is shown here because it
 * decides how products taxed by use (software, for example) are charged.
 */
export function CustomerExemptionsTab({ partyId, taxUse }: Readonly<CustomerExemptionsTabProps>) {
  const { t } = useSetupTexts();
  const te = t.exemptions;
  const { can } = usePermissions();
  const canRead = can('taxes:read');
  const canCreate = can('taxes:create');
  const query = useExemptionCertificates({ partyId }, { enabled: canRead });
  const rows = query.data ?? [];
  const useLabel = taxUse === 'business' || taxUse === 'personal' ? te.defaultUseValues[taxUse] : te.defaultUseNone;

  if (!canRead) return <p className="text-sm text-muted-foreground">{t.common.noAccess}</p>;

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{te.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.common.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <FileCheck2 className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
          <p className="font-medium">{te.emptyTitle}</p>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{te.emptyDescription}</p>
        </CardContent>
      </Card>
    );
  } else {
    body = <CertificatesTable certificates={rows} showCustomer={false} />;
  }

  return (
    <section className="space-y-4" aria-labelledby="exemptions-title" data-testid="customer-exemptions">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="exemptions-title" className="text-lg font-semibold">
            {te.title}
          </h2>
          <p className="text-sm text-muted-foreground">{te.description}</p>
          <p className="text-sm">
            <span className="text-muted-foreground">{te.defaultUse}: </span>
            <span className="font-medium" data-testid="customer-default-use">
              {useLabel}
            </span>
          </p>
        </div>
        {canCreate ? (
          <Button asChild>
            <Link to="/weldbooks/sales-tax/certificates/new" search={{ partyId }}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              {te.add}
            </Link>
          </Button>
        ) : null}
      </div>
      {body}
    </section>
  );
}
