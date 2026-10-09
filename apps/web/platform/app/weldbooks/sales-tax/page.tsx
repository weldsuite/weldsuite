import { Link } from '@tanstack/react-router';
import { AlertTriangle, Landmark } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useSalesTaxOverview } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { AgencyOverview } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { AgencyOverviewCard } from './overview/agency-overview-card';
import { CardsSkeleton, EmptyState, ErrorState } from './shared/query-states';
import { AgenciesLink } from './shared/setup-links';
import { SalesTaxFrame } from './shared/sales-tax-frame';
import { fill } from './shared/text';
import { useOpenReturn } from './shared/use-open-return';

interface StatCardProps {
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'danger' | 'warning';
}

function StatCard({ label, value, hint, tone = 'default' }: Readonly<StatCardProps>) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            'text-2xl font-semibold tabular-nums',
            tone === 'danger' && 'text-destructive',
            tone === 'warning' && 'text-amber-600 dark:text-amber-400',
          )}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function OverviewContent() {
  const { t } = useI18n();
  const to = t.weldbooksUs.salesTax.center.overview;
  const { can } = usePermissions();
  const { formatMoney } = useWeldbooksFormat();
  const { data, isLoading, isError, error, refetch } = useSalesTaxOverview();
  const { open, openingKey } = useOpenReturn();

  const openReturn = (agency: AgencyOverview) => {
    const next = agency.nextPeriod;
    if (!next) return;
    void open(agency.agencyId, { agencyId: agency.agencyId, periodStart: next.periodStart, periodEnd: next.periodEnd });
  };

  if (isLoading) return <CardsSkeleton count={3} />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  if (data.agencies.length === 0) {
    return (
      <EmptyState
        icon={Landmark}
        title={to.emptyTitle}
        description={to.emptyDescription}
        action={
          <>
            <Button asChild>
              <AgenciesLink>{to.setUpAgencies}</AgenciesLink>
            </Button>
            <Button asChild variant="outline">
              <Link to="/weldbooks/sales-tax/nexus">{to.checkNexus}</Link>
            </Button>
          </>
        }
      />
    );
  }

  const { totals } = data;
  return (
    <div className="space-y-4">
      {totals.overduePeriods > 0 ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            {totals.overduePeriods === 1
              ? to.overdueBannerOne
              : fill(to.overdueBannerMany, { count: totals.overduePeriods })}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={to.estimatedTaxDue} value={formatMoney(totals.estimatedTaxDue)} hint={to.estimatedTaxDueHint} />
        <StatCard
          label={to.overduePeriods}
          value={String(totals.overduePeriods)}
          hint={to.overduePeriodsHint}
          tone={totals.overduePeriods > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label={to.dueSoon}
          value={String(totals.dueWithin14Days)}
          hint={to.dueSoonHint}
          tone={totals.dueWithin14Days > 0 ? 'warning' : 'default'}
        />
      </div>

      <section aria-label={to.agencyList} className="space-y-3">
        {data.agencies.map((agency) => (
          <AgencyOverviewCard
            key={agency.agencyId}
            agency={agency}
            canCreate={can('taxes:create')}
            openingAgencyId={openingKey}
            onOpenReturn={openReturn}
          />
        ))}
      </section>
    </div>
  );
}

/** The Sales Tax Center: every registered agency with what is due and when, what is overdue and the estimate. */
export default function SalesTaxOverviewPage() {
  const { t } = useI18n();
  const to = t.weldbooksUs.salesTax.center.overview;

  return (
    <SalesTaxFrame
      title={to.title}
      subtitle={to.subtitle}
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link to="/weldbooks/sales-tax/returns">{to.allReturns}</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/weldbooks/sales-tax/nexus">{to.nexusMonitor}</Link>
          </Button>
        </>
      }
    >
      <OverviewContent />
    </SalesTaxFrame>
  );
}
