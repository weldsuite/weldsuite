import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Landmark } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useSalesTaxLiabilityReport } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { AgencyLiabilityRow } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { CardsSkeleton, EmptyState, ErrorState } from '../shared/query-states';
import { AgenciesLink } from '../shared/setup-links';
import { fill, toCents } from '../shared/text';

function Figure({ label, value, danger }: Readonly<{ label: string; value: string; danger?: boolean }>) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('text-xl font-semibold tabular-nums', danger && 'text-destructive')}>{value}</p>
      </CardContent>
    </Card>
  );
}

function AgencyRows({ agency, open, onToggle }: Readonly<{ agency: AgencyLiabilityRow; open: boolean; onToggle: () => void }>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.salesTax.center.reports.liability;
  const levels = t.weldbooksUs.salesTax.center.levels as Record<string, string>;
  const { formatMoney } = useWeldbooksFormat();
  const ties = toCents(agency.difference) === 0;

  return (
    <Fragment>
      <TableRow data-testid={`liability-agency-${agency.stateCode}`}>
        <TableCell className="w-8 pr-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-expanded={open}
            aria-label={open ? tl.hideJurisdictions : tl.showJurisdictions}
            onClick={onToggle}
          >
            {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </TableCell>
        <TableCell>
          <span className="font-medium">{agency.agencyName}</span>
          <Badge variant="outline" className="ml-2">
            {agency.stateCode}
          </Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(agency.collected)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(agency.filed)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(agency.paid)}</TableCell>
        <TableCell className="text-right tabular-nums font-medium">{formatMoney(agency.outstanding)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(agency.unfiled)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(agency.filedUnpaid)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(agency.glBalance)}</TableCell>
        <TableCell className={cn('text-right tabular-nums', !ties && 'font-medium text-destructive')}>
          {ties ? <span className="text-muted-foreground">{tl.ties}</span> : formatMoney(agency.difference)}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={10} className="whitespace-normal p-3">
            <div className="space-y-2">
              {agency.warnings.length > 0 ? <p className="text-xs text-muted-foreground">{tl.sharedAccount}</p> : null}
              <div className="rounded-md border bg-background">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tl.jurisdiction}</TableHead>
                      <TableHead>{tl.level}</TableHead>
                      <TableHead className="text-right">{tl.collected}</TableHead>
                      <TableHead className="text-right">{tl.filed}</TableHead>
                      <TableHead className="text-right">{tl.paid}</TableHead>
                      <TableHead className="text-right">{tl.outstanding}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agency.jurisdictions.map((jurisdiction) => (
                      <TableRow key={jurisdiction.jurisdictionCode}>
                        <TableCell>
                          {jurisdiction.jurisdictionName}
                          <span className="ml-2 text-xs text-muted-foreground">{jurisdiction.jurisdictionCode}</span>
                        </TableCell>
                        <TableCell>{levels[jurisdiction.level] ?? jurisdiction.level}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(jurisdiction.collected)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(jurisdiction.filed)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(jurisdiction.paid)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(jurisdiction.outstanding)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

/** What is collected, filed, paid and owed per agency and jurisdiction, tied to the agency payable accounts. */
export function LiabilityReport() {
  const { t } = useI18n();
  const tl = t.weldbooksUs.salesTax.center.reports.liability;
  const tc = t.weldbooksUs.salesTax.center.common;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const [asOf, setAsOf] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const query = useSalesTaxLiabilityReport(asOf || undefined);
  const report = query.data;

  const toggle = (agencyId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(agencyId)) next.delete(agencyId);
      else next.add(agencyId);
      return next;
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{tl.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="liability-as-of">{tc.asOf}</Label>
          <Input
            id="liability-as-of"
            type="date"
            className="w-40"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </div>
        {report ? <p className="pb-2 text-xs text-muted-foreground">{fill(tc.asOfDate, { date: formatDate(report.asOf) })}</p> : null}
      </div>

      {query.isLoading ? (
        <CardsSkeleton count={6} />
      ) : query.isError && !report ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : report && report.agencies.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title={tl.empty}
          description={tl.emptyDescription}
          action={
            <Button asChild variant="outline">
              <AgenciesLink>{t.weldbooksUs.salesTax.center.overview.setUpAgencies}</AgenciesLink>
            </Button>
          }
        />
      ) : report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Figure label={tl.collected} value={formatMoney(report.totals.collected)} />
            <Figure label={tl.filed} value={formatMoney(report.totals.filed)} />
            <Figure label={tl.paid} value={formatMoney(report.totals.paid)} />
            <Figure label={tl.outstanding} value={formatMoney(report.totals.outstanding)} />
            <Figure label={tl.glBalance} value={formatMoney(report.totals.glBalance)} />
            <Figure
              label={tl.difference}
              value={formatMoney(report.totals.difference)}
              danger={toCents(report.totals.difference) !== 0}
            />
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">{tc.details}</span>
                    </TableHead>
                    <TableHead>{tl.agency}</TableHead>
                    <TableHead className="text-right">{tl.collected}</TableHead>
                    <TableHead className="text-right">{tl.filed}</TableHead>
                    <TableHead className="text-right">{tl.paid}</TableHead>
                    <TableHead className="text-right">{tl.outstanding}</TableHead>
                    <TableHead className="text-right">{tl.notFiled}</TableHead>
                    <TableHead className="text-right">{tl.filedUnpaid}</TableHead>
                    <TableHead className="text-right">{tl.glBalance}</TableHead>
                    <TableHead className="text-right">{tl.difference}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.agencies.map((agency) => (
                    <AgencyRows
                      key={agency.agencyId}
                      agency={agency}
                      open={open.has(agency.agencyId)}
                      onToggle={() => toggle(agency.agencyId)}
                    />
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell />
                    <TableCell>{tl.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(report.totals.collected)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(report.totals.filed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(report.totals.paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(report.totals.outstanding)}</TableCell>
                    <TableCell />
                    <TableCell />
                    <TableCell className="text-right tabular-nums">{formatMoney(report.totals.glBalance)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(report.totals.difference)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
