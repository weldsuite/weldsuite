import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useSalesTaxSettings } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../setup/setup-gate';
import { useSetupTexts } from '../setup/setup-texts';
import { AgencyStatusBadge } from '../setup/status-badges';
import { AddressCheck } from './address-check';
import { EngineForm } from './engine-form';
import { RegistrationCheck } from './registration-check';

function EngineSettings() {
  const { t } = useSetupTexts();
  const te = t.engine;
  const { canUpdate } = useSalesTaxSetupAccess();
  const query = useSalesTaxSettings();
  const settings = query.data;

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (query.isError || !settings) {
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
  } else {
    body = (
      <>
        <EngineForm settings={settings} canUpdate={canUpdate} />
        <RegistrationCheck settings={settings} canRun={canUpdate} />
        <AddressCheck settings={settings} />
        <Card>
          <CardHeader>
            <CardTitle>{te.agencies.title}</CardTitle>
            <CardDescription>
              <Link to="/weldbooks/sales-tax/agencies" className="text-primary underline-offset-4 hover:underline">
                {te.agencies.manage}
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settings.agencies.length === 0 ? (
              <p className="text-sm text-muted-foreground">{te.agencies.empty}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {settings.agencies.map((agency) => (
                  <li key={agency.id}>
                    <Link
                      to="/weldbooks/sales-tax/agencies/$id"
                      params={{ id: agency.id }}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                    >
                      <span className="font-medium">{salesTaxStateName(agency.stateCode)}</span>
                      {agency.level === 'local' ? <Badge variant="outline">{t.agencies.localBadge}</Badge> : null}
                      <AgencyStatusBadge status={agency.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link to="/weldbooks/sales-tax/agencies">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            {t.agencies.title}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{te.title}</h1>
        <p className="text-sm text-muted-foreground">{te.subtitle}</p>
      </div>
      {body}
    </div>
  );
}

export default function SalesTaxEngineSettingsPage() {
  return (
    <SalesTaxSetupGate>
      <EngineSettings />
    </SalesTaxSetupGate>
  );
}
