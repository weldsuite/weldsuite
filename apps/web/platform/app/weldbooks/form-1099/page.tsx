import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AlertCircle, AlertTriangle, FileText } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import { useForm1099Summary } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { DeadlinesBanner } from './components/deadlines-banner';
import { FilingsPanel } from './components/filings-panel';
import { Form945Panel } from './components/form-945-panel';
import { SummaryCards } from './components/summary-cards';
import { TinMatchingPanel } from './components/tin-matching-panel';
import { VendorDrilldownDialog } from './components/vendor-drilldown-dialog';
import { VendorReviewTable } from './components/vendor-review-table';
import { defaultTaxYear, isForm1099Tab, taxYearChoices, type Form1099Tab } from './form-1099-model';

/**
 * The 1099 Center: the year-end review of who gets a form, the NEC and MISC
 * filings with their IRIS files and recipient copies, IRS TIN matching and
 * the Form 945 summary of backup withholding.
 */
export default function Form1099CenterPage() {
  const { t } = useI18n();
  const tc = t.weldbooksUs.form1099.center;
  const { can } = usePermissions();
  const { features, isResolved, isError } = useCurrentJurisdiction();
  const search = useSearch({ from: '/weldbooks/form-1099/' });
  const navigate = useNavigate({ from: '/weldbooks/form-1099/' });
  const [drilldown, setDrilldown] = useState<string | null>(null);

  const year = search.year ?? defaultTaxYear();
  const tab: Form1099Tab = isForm1099Tab(search.tab) ? search.tab : 'review';
  const enabled = features.form1099 && can('taxes:read');
  const summary = useForm1099Summary(year, { enabled });

  const setSearch = (patch: { year?: number; tab?: Form1099Tab }) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  if (!can('taxes:read')) {
    return (
      <AccessDeniedEmptyState description={tc.noAccess} permission="taxes:read" pageLabel={tc.title} />
    );
  }
  if (!isResolved && !isError) return <PageLoader fullScreen={false} />;
  if (!features.form1099) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 text-center" data-testid="form1099-unavailable">
        <EmptyStateIllustration>
          <FileText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
        </EmptyStateIllustration>
        <h1 className="text-lg font-semibold">{tc.title}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{tc.usOnly}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{tc.title}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{tc.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="form1099-year" className="text-sm text-muted-foreground">
            {tc.taxYear}
          </Label>
          <Select value={String(year)} onValueChange={(value) => setSearch({ year: Number(value) })}>
            <SelectTrigger id="form1099-year" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {taxYearChoices().map((choice) => (
                <SelectItem key={choice} value={String(choice)}>
                  {choice}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DeadlinesBanner year={year} />

      <Tabs value={tab} onValueChange={(value) => isForm1099Tab(value) && setSearch({ tab: value })}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="review">{tc.tabs.review}</TabsTrigger>
          <TabsTrigger value="filings">{tc.tabs.filings}</TabsTrigger>
          <TabsTrigger value="tin-matching">{tc.tabs.tinMatching}</TabsTrigger>
          <TabsTrigger value="form-945">{tc.tabs.form945}</TabsTrigger>
        </TabsList>

        <TabsContent value="review" className="space-y-4 pt-2">
          {summary.isLoading ? (
            <PageLoader fullScreen={false} className="min-h-40" />
          ) : summary.isError || !summary.data ? (
            <div className="flex flex-col items-center gap-3 rounded-md border p-8 text-center" role="alert">
              <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
              <p className="text-sm text-muted-foreground">{tc.loadError}</p>
              <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
                {tc.retry}
              </Button>
            </div>
          ) : (
            <>
              <SummaryCards summary={summary.data} />
              {summary.data.warnings.length > 0 ? (
                <Alert data-testid="review-warnings">
                  <AlertTriangle aria-hidden />
                  <AlertTitle>{tc.warnings.replace('{n}', String(summary.data.warnings.length))}</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {summary.data.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              <VendorReviewTable vendors={summary.data.vendors} onOpenDetails={setDrilldown} />
            </>
          )}
        </TabsContent>

        <TabsContent value="filings" className="pt-2">
          <FilingsPanel year={year} summary={summary.data} />
        </TabsContent>

        <TabsContent value="tin-matching" className="pt-2">
          <TinMatchingPanel />
        </TabsContent>

        <TabsContent value="form-945" className="pt-2">
          <Form945Panel year={year} enabled={tab === 'form-945'} />
        </TabsContent>
      </Tabs>

      <VendorDrilldownDialog partyId={drilldown} year={year} onOpenChange={(open) => !open && setDrilldown(null)} />
    </div>
  );
}
