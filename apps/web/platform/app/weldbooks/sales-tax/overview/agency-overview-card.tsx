import { Link } from '@tanstack/react-router';
import { CalendarClock, Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { AgencyOverview } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { PeriodStateBadge, ReturnStatusBadge } from '../shared/badges';
import { dueCountdown, dueTone, fill } from '../shared/text';

/** What the card's button does for the agency's next period. */
export type NextPeriodAction = 'continue' | 'open' | 'upcoming' | 'none';

export function nextPeriodAction(next: AgencyOverview['nextPeriod']): NextPeriodAction {
  if (!next) return 'none';
  if (next.returnId) return 'continue';
  return next.state === 'upcoming' ? 'upcoming' : 'open';
}

interface AgencyOverviewCardProps {
  agency: AgencyOverview;
  canCreate: boolean;
  /** The agency whose return is being opened right now. */
  openingAgencyId: string | null;
  onOpenReturn: (agency: AgencyOverview) => void;
}

/** One agency: its next period with the due date and estimate, what is overdue and what was filed last. */
export function AgencyOverviewCard({ agency, canCreate, openingAgencyId, onOpenReturn }: Readonly<AgencyOverviewCardProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center;
  const to = tc.overview;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const next = agency.nextPeriod;
  const action = nextPeriodAction(next);
  const opening = openingAgencyId === agency.agencyId;
  const frequencies = tc.frequencies as Record<string, string>;
  const bases = tc.bases as Record<string, string>;
  const tone = next ? dueTone(next.daysUntilDue) : 'later';
  const returnDone = next?.returnStatus === 'filed' || next?.returnStatus === 'paid';

  return (
    <Card data-testid={`agency-card-${agency.stateCode}`}>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-semibold text-primary"
              aria-hidden="true"
            >
              {agency.stateCode}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{agency.agencyName}</p>
              <p className="text-xs text-muted-foreground">
                {frequencies[agency.filingFrequency] ?? agency.filingFrequency}
                {' · '}
                {fill(tc.basisLabel, { basis: bases[agency.reportingBasis] ?? agency.reportingBasis })}
              </p>
            </div>
          </div>
          {agency.overduePeriods > 0 ? (
            <Badge variant="destructive">
              {agency.overduePeriods === 1
                ? to.overdueBadgeOne
                : fill(to.overdueBadgeMany, { count: agency.overduePeriods })}
            </Badge>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-start">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{to.nextPeriod}</p>
            {next ? (
              <>
                <p className="text-sm font-medium">
                  {fill(to.periodRange, { start: formatDate(next.periodStart), end: formatDate(next.periodEnd) })}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <PeriodStateBadge state={next.state} />
                  {next.returnStatus ? <ReturnStatusBadge status={next.returnStatus} /> : null}
                </div>
                <p
                  className={cn(
                    'flex items-center gap-1 text-sm',
                    returnDone
                      ? 'text-muted-foreground'
                      : tone === 'overdue'
                        ? 'font-medium text-destructive'
                        : tone === 'soon'
                          ? 'font-medium text-amber-600 dark:text-amber-400'
                          : 'text-muted-foreground',
                  )}
                >
                  <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{fill(tc.due.dueOn, { date: formatDate(next.dueDate) })}</span>
                  {returnDone ? null : <span>· {dueCountdown(tc.due, next.daysUntilDue)}</span>}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">{to.noPeriod}</p>
                <p className="text-xs text-muted-foreground">{to.noPeriodHint}</p>
              </>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{to.estimatedTax}</p>
            {next ? (
              <>
                <p className="text-lg font-semibold tabular-nums">{formatMoney(next.estimatedTaxDue)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {fill(to.estimatedBreakdown, {
                    sales: formatMoney(next.estimatedSalesTax),
                    use: formatMoney(next.estimatedUseTax),
                  })}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{to.lastFiled}</p>
            {agency.lastFiled ? (
              <>
                <p className="text-sm font-medium">
                  <Link
                    to="/weldbooks/sales-tax/returns/$id"
                    params={{ id: agency.lastFiled.returnId }}
                    className="text-primary hover:underline"
                  >
                    {fill(to.periodEnding, { date: formatDate(agency.lastFiled.periodEnd) })}
                  </Link>
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {fill(to.filedOn, { date: formatDate(agency.lastFiled.filedAt) })}
                  {' · '}
                  {formatMoney(agency.lastFiled.totalDue)}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{to.nothingFiled}</p>
            )}
          </div>

          <div className="flex md:justify-end">
            {action === 'continue' && next?.returnId ? (
              <Button asChild size="sm" variant={returnDone ? 'outline' : 'default'}>
                <Link to="/weldbooks/sales-tax/returns/$id" params={{ id: next.returnId }}>
                  {returnDone ? to.viewReturn : to.continueReturn}
                </Link>
              </Button>
            ) : null}
            {action === 'open' && canCreate ? (
              <Button size="sm" onClick={() => onOpenReturn(agency)} disabled={opening}>
                {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {opening ? to.opening : to.openReturn}
              </Button>
            ) : null}
            {action === 'upcoming' && next ? (
              <p className="text-xs text-muted-foreground">{fill(to.startsOn, { date: formatDate(next.periodStart) })}</p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
