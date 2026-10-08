import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ShoppingCart } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useSalesSummaryReport } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { SALES_SUMMARY_GROUPS, type SalesSummaryGroup, type SalesSummaryRow } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DateRangeFilter, startOfYear } from '../shared/date-range';
import { EmptyState, ErrorState, RowsSkeleton } from '../shared/query-states';
import { fill } from '../shared/text';

interface SummaryRowProps {
  row: SalesSummaryRow;
  open: boolean;
  onToggle: () => void;
}

function SummaryRow({ row, open, onToggle }: Readonly<SummaryRowProps>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.salesTax.center.reports.salesSummary;
  const levels = t.weldbooksUs.salesTax.center.levels as Record<string, string>;
  const reasons = t.weldbooksUs.salesTax.center.exemptReasons as Record<string, string>;
  const { formatMoney } = useWeldbooksFormat();
  const breakdown = Object.entries(row.exemptByReason).filter(([, amount]) => amount !== 0);

  return (
    <Fragment>
      <TableRow data-testid="sales-summary-row">
        <TableCell className="w-8 pr-0">
          {breakdown.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-expanded={open}
              aria-label={ts.exemptByReason}
              onClick={onToggle}
            >
              {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            </Button>
          ) : null}
        </TableCell>
        <TableCell>
          <span className="font-medium">{row.label}</span>
          {row.level ? (
            <Badge variant="outline" className="ml-2">
              {levels[row.level] ?? row.level}
            </Badge>
          ) : null}
        </TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(row.grossSales)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(row.taxableSales)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(row.exemptSales)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(row.nonTaxableSales)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(row.marketplaceSales)}</TableCell>
        <TableCell className="text-right tabular-nums font-medium">{formatMoney(row.tax)}</TableCell>
        <TableCell className="text-right tabular-nums">{row.documents}</TableCell>
      </TableRow>
      {open && breakdown.length > 0 ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={8} className="whitespace-normal">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{ts.exemptByReason}</p>
            <ul className="flex flex-wrap gap-2">
              {breakdown.map(([reason, amount]) => (
                <li key={reason}>
                  <Badge variant="secondary">
                    {reasons[reason] ?? reason}: {formatMoney(amount)}
                  </Badge>
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

/** Gross, taxable, exempt and non-taxable sales with the tax charged, by state, customer or jurisdiction. */
export function SalesSummaryReport() {
  const { t } = useI18n();
  const ts = t.weldbooksUs.salesTax.center.reports.salesSummary;
  const tc = t.weldbooksUs.salesTax.center.common;
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const [range, setRange] = useState(() => {
    const now = today();
    return { from: startOfYear(now), to: now };
  });
  const [groupBy, setGroupBy] = useState<SalesSummaryGroup>('state');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const query = useSalesSummaryReport({ from: range.from || undefined, to: range.to || undefined, groupBy });
  const report = query.data;
  const groups = ts.groups as Record<SalesSummaryGroup, string>;
  const labelColumns = ts.labelColumns as Record<SalesSummaryGroup, string>;

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{ts.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter idPrefix="sales-summary" from={range.from} to={range.to} onChange={setRange} />
        <div className="space-y-1.5">
          <Label htmlFor="sales-summary-group">{ts.groupBy}</Label>
          <Select value={groupBy} onValueChange={(value) => setGroupBy(value as SalesSummaryGroup)}>
            <SelectTrigger id="sales-summary-group" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SALES_SUMMARY_GROUPS.map((group) => (
                <SelectItem key={group} value={group}>
                  {groups[group]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {report ? (
        <p className="text-xs text-muted-foreground">
          {fill(tc.showingRange, { from: formatDate(report.from), to: formatDate(report.to) })}
        </p>
      ) : null}

      {query.isLoading ? (
        <RowsSkeleton rows={6} />
      ) : query.isError && !report ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : report && report.rows.length === 0 ? (
        <EmptyState icon={ShoppingCart} title={ts.empty} description={ts.emptyDescription} />
      ) : report ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <span className="sr-only">{tc.details}</span>
                  </TableHead>
                  <TableHead>{labelColumns[groupBy]}</TableHead>
                  <TableHead className="text-right">{ts.grossSales}</TableHead>
                  <TableHead className="text-right">{ts.taxableSales}</TableHead>
                  <TableHead className="text-right">{ts.exemptSales}</TableHead>
                  <TableHead className="text-right">{ts.nonTaxableSales}</TableHead>
                  <TableHead className="text-right">{ts.marketplaceSales}</TableHead>
                  <TableHead className="text-right">{ts.tax}</TableHead>
                  <TableHead className="text-right">{ts.documents}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row) => (
                  <SummaryRow key={`${row.key}|${row.level ?? ''}`} row={row} open={open.has(row.key)} onToggle={() => toggle(row.key)} />
                ))}
              </TableBody>
              <TableFooter>
                <TableRow data-testid="sales-summary-total">
                  <TableCell />
                  <TableCell>{ts.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(report.totals.grossSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(report.totals.taxableSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(report.totals.exemptSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(report.totals.nonTaxableSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(report.totals.marketplaceSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(report.totals.tax)}</TableCell>
                  <TableCell className="text-right tabular-nums">{report.totals.documents}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
