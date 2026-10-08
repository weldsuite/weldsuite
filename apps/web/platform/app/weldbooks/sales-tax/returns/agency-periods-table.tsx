import { Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { AgencyPeriods, PeriodRow } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { PeriodStateBadge, ReturnStatusBadge } from '../shared/badges';
import { dueCountdown, dueTone, fill } from '../shared/text';

interface AgencyPeriodsTableProps {
  agency: AgencyPeriods;
  canCreate: boolean;
  openingKey: string | null;
  onOpenReturn: (agency: AgencyPeriods, period: PeriodRow) => void;
}

/** The key that tells which period is being opened. */
export function periodKey(period: Pick<PeriodRow, 'agencyId' | 'periodEnd'>): string {
  return `${period.agencyId}:${period.periodEnd}`;
}

/** The periods of one agency: due date, state, return, amount and the way into the return. */
export function AgencyPeriodsTable({ agency, canCreate, openingKey, onOpenReturn }: Readonly<AgencyPeriodsTableProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center;
  const tp = tc.periodsPage;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const frequencies = tc.frequencies as Record<string, string>;
  const bases = tc.bases as Record<string, string>;

  return (
    <Card data-testid={`agency-periods-${agency.stateCode}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{agency.agencyName}</span>
          <Badge variant="outline">{agency.stateCode}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {fill(tp.filingSetup, {
            frequency: frequencies[agency.filingFrequency] ?? agency.filingFrequency,
            day: agency.dueDay,
            basis: bases[agency.reportingBasis] ?? agency.reportingBasis,
          })}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {agency.periods.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">{tp.emptyAgency}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tp.period}</TableHead>
                  <TableHead>{tp.dueDate}</TableHead>
                  <TableHead>{tp.state}</TableHead>
                  <TableHead>{tp.returnColumn}</TableHead>
                  <TableHead className="text-right">{tp.totalDue}</TableHead>
                  <TableHead>{tp.filed}</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">{tc.common.actions}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agency.periods.map((period) => {
                  const ret = period.return;
                  const done = ret?.status === 'filed' || ret?.status === 'paid';
                  const tone = dueTone(period.daysUntilDue);
                  const opening = openingKey === periodKey(period);
                  const canOpenNew = !ret && canCreate && period.state !== 'upcoming';
                  return (
                    <TableRow key={period.key} data-testid={`period-${period.periodEnd}`}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {fill(tc.overview.periodRange, {
                          start: formatDate(period.periodStart),
                          end: formatDate(period.periodEnd),
                        })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div>{formatDate(period.dueDate)}</div>
                        {done ? null : (
                          <div
                            className={cn(
                              'text-xs',
                              tone === 'overdue'
                                ? 'font-medium text-destructive'
                                : tone === 'soon'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-muted-foreground',
                            )}
                          >
                            {dueCountdown(tc.due, period.daysUntilDue)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <PeriodStateBadge state={period.state} />
                      </TableCell>
                      <TableCell>
                        {ret ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ReturnStatusBadge status={ret.status} />
                            {period.amendments.length > 0 ? (
                              <span className="text-xs text-muted-foreground">
                                {tp.amendments}:{' '}
                                {period.amendments.map((amendment, index) => (
                                  <span key={amendment.id}>
                                    {index > 0 ? ', ' : ''}
                                    <Link
                                      to="/weldbooks/sales-tax/returns/$id"
                                      params={{ id: amendment.id }}
                                      className="text-primary hover:underline"
                                    >
                                      {tp.amended}
                                    </Link>
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">{tp.noReturn}</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {ret ? formatMoney(ret.totalDue) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {ret?.filedAt ? (
                          <>
                            <div>{formatDate(ret.filedAt)}</div>
                            {ret.confirmationNumber ? (
                              <div className="text-xs text-muted-foreground">
                                {fill(tp.confirmation, { number: ret.confirmationNumber })}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {ret ? (
                          <Button asChild variant="outline" size="sm">
                            <Link to="/weldbooks/sales-tax/returns/$id" params={{ id: ret.id }}>
                              {tp.viewReturn}
                            </Link>
                          </Button>
                        ) : canOpenNew ? (
                          <Button size="sm" onClick={() => onOpenReturn(agency, period)} disabled={opening}>
                            {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                            {tp.openReturn}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
