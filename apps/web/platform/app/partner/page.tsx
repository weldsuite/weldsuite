/**
 * Partner overview: this month at a glance, the contract in plain words, and
 * the workspaces about to run out of credits.
 */

import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Progress } from '@weldsuite/ui/components/progress';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerOverview } from '@/hooks/queries/use-partner-queries';
import { formatPercentBps } from '@/lib/partner/money';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { ErrorBlock, LoadingBlock, PageHeader, PartnerStatusBadge, StatCard, errorText, useFormatters } from './components/kit';

export default function PartnerOverviewPage() {
  const { t, format } = useI18n();
  const f = useFormatters();
  const { membership } = usePartnerContext();
  const { data, isLoading, error, refetch } = usePartnerOverview();
  const to = t.partner.overview;

  if (isLoading) {
    return (
      <>
        <PageHeader title={to.title} description={to.description} />
        <LoadingBlock rows={3} />
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <PageHeader title={to.title} />
        <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />
      </>
    );
  }

  const { contract, currentMonth } = data;
  const currency = currentMonth?.currency ?? contract?.currency ?? 'USD';

  return (
    <>
      <PageHeader
        title={data.partner.name}
        description={to.description}
        actions={membership.status !== 'active' ? <PartnerStatusBadge status={data.partner.status} /> : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={to.activeWorkspaces}
          value={f.number(data.activeWorkspaceCount)}
          hint={format(to.ofTotal, { total: data.workspaceCount })}
        />
        {currentMonth ? (
          <>
            <StatCard label={to.resaleTotal} value={f.money(currentMonth.totalResale, currency)} hint={to.resaleHint} />
            <StatCard
              label={to.weldsuiteShare}
              value={f.money(currentMonth.totalDue, currency)}
              hint={to.weldsuiteHint}
            />
            <StatCard
              label={to.partnerMargin}
              value={f.money(currentMonth.totalMargin, currency)}
              hint={to.marginHint}
              tone={currentMonth.totalMargin.startsWith('-') ? 'negative' : 'positive'}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">{to.noBillingAccess}</p>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{to.contractTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {contract ? (
              <ul className="space-y-2 text-sm">
                <li>{format(to.revenueShare, { percent: formatPercentBps(contract.revenueShareBps) })}</li>
                <li>
                  {format(to.baseMinimum, { amount: f.money(contract.baseMinimum, contract.currency) })}
                </li>
                <li>{format(to.includedCredits, { count: f.number(contract.includedCredits) })}</li>
                <li>{format(to.creditFloor, { price: f.unitPrice(contract.creditFloorPrice, contract.currency) })}</li>
                <li>{format(to.extraCreditPrice, { price: f.unitPrice(contract.extraCreditPrice, contract.currency) })}</li>
                <li>{format(to.paymentTerms, { days: contract.paymentTermsDays })}</li>
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{to.noContract}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{to.nearLimitTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.nearCreditLimit.length === 0 ? (
              <p className="text-sm text-muted-foreground">{to.nearLimitEmpty}</p>
            ) : (
              <ul className="space-y-4">
                {data.nearCreditLimit.map((w) => {
                  const left = w.monthlyCredits > 0 ? Math.max(0, Math.min(100, (w.creditBalance / w.monthlyCredits) * 100)) : 0;
                  return (
                    <li key={w.workspaceId} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <Link
                          to="/partner/workspaces/$workspaceId"
                          params={{ workspaceId: w.workspaceId }}
                          className="truncate font-medium hover:underline"
                        >
                          {w.name}
                        </Link>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {format(to.nearLimitRow, {
                            balance: f.number(w.creditBalance),
                            allowance: f.number(w.monthlyCredits),
                          })}
                        </span>
                      </div>
                      <Progress value={left} />
                    </li>
                  );
                })}
              </ul>
            )}
            <Link to="/partner/workspaces" className="mt-4 inline-block text-sm font-medium underline underline-offset-2">
              {to.viewAll}
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
