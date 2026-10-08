import { Link } from '@tanstack/react-router';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useCheckSalesTaxRegistrations } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxSettings } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { useSetupTexts } from '../setup/setup-texts';

export interface RegistrationCheckProps {
  settings: SalesTaxSettings;
  canRun: boolean;
}

/**
 * Compares the registrations at the provider (Stripe Tax or Avalara) with the
 * agencies registered here. The provider only calculates tax in states where it
 * has a registration, so a state missing on either side means a wrong invoice.
 */
export function RegistrationCheck({ settings, canRun }: Readonly<RegistrationCheckProps>) {
  const { t, format } = useSetupTexts();
  const tr = t.engine.registrations;
  const check = useCheckSalesTaxRegistrations();
  const result = check.data;
  const provider = settings.engine === 'manual' ? null : t.engine.options[settings.engine].name;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tr.title}</CardTitle>
        <CardDescription>{provider ? format(tr.description, { engine: provider }) : tr.manual}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {provider && canRun ? (
          <Button type="button" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {check.isPending ? tr.running : tr.run}
          </Button>
        ) : null}

        {check.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{check.error instanceof Error && check.error.message ? check.error.message : tr.error}</AlertDescription>
          </Alert>
        ) : null}

        {result && provider ? (
          <div className="space-y-5" data-testid="registration-result">
            <div className="flex items-start gap-2 text-sm">
              {result.inSync ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
              ) : (
                <TriangleAlert className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
              )}
              <p>{format(result.inSync ? tr.inSync : tr.notInSync, { engine: provider })}</p>
            </div>

            {result.missingInProvider.length > 0 ? (
              <section className="space-y-2" aria-label={format(tr.missingInProvider, { engine: provider })}>
                <h3 className="text-sm font-medium">{format(tr.missingInProvider, { engine: provider })}</h3>
                <p className="text-sm text-muted-foreground">{format(tr.missingInProviderHelp, { engine: provider })}</p>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tr.columns.state}</TableHead>
                        <TableHead>{tr.columns.agency}</TableHead>
                        <TableHead className="w-40" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.missingInProvider.map((row) => (
                        <TableRow key={row.agencyId}>
                          <TableCell className="font-medium">
                            {salesTaxStateName(row.stateCode)} ({row.stateCode})
                          </TableCell>
                          <TableCell>{row.name}</TableCell>
                          <TableCell className="text-right">
                            <Button asChild variant="ghost" size="sm">
                              <Link to="/weldbooks/sales-tax/agencies/$id" params={{ id: row.agencyId }}>
                                {tr.openAgency}
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}

            {result.missingInWeldBooks.length > 0 ? (
              <section className="space-y-2" aria-label={format(tr.missingInWeldBooks, { engine: provider })}>
                <h3 className="text-sm font-medium">{format(tr.missingInWeldBooks, { engine: provider })}</h3>
                <p className="text-sm text-muted-foreground">{format(tr.missingInWeldBooksHelp, { engine: provider })}</p>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tr.columns.state}</TableHead>
                        <TableHead>{tr.columns.reference}</TableHead>
                        <TableHead className="w-40" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.missingInWeldBooks.map((row) => (
                        <TableRow key={row.stateCode}>
                          <TableCell className="font-medium">
                            {salesTaxStateName(row.stateCode)} ({row.stateCode})
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{row.providerRef}</TableCell>
                          <TableCell className="text-right">
                            <Button asChild variant="outline" size="sm">
                              <Link to="/weldbooks/sales-tax/agencies/new" search={{ state: row.stateCode }}>
                                {tr.createAgency}
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}

            {result.matched.length > 0 ? (
              <section className="space-y-2" aria-label={tr.matched}>
                <h3 className="text-sm font-medium">{tr.matched}</h3>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tr.columns.state}</TableHead>
                        <TableHead>{tr.columns.agency}</TableHead>
                        <TableHead>{tr.columns.reference}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.matched.map((row) => (
                        <TableRow key={row.agencyId}>
                          <TableCell className="font-medium">
                            {salesTaxStateName(row.stateCode)} ({row.stateCode})
                          </TableCell>
                          <TableCell>{row.name}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{row.providerRef ?? t.common.none}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
