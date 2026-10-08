import { useMemo, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useSalesTaxExceptionsReport } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  EXCEPTION_KINDS,
  type SalesTaxException,
  type SalesTaxExceptionKind,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DateRangeFilter, startOfYear } from '../shared/date-range';
import { DocumentLink } from '../shared/document-link';
import { EmptyState, ErrorState, RowsSkeleton } from '../shared/query-states';
import { fill } from '../shared/text';

type KindFilter = 'all' | SalesTaxExceptionKind;

const SEVERITY_VARIANT = { error: 'destructive', warning: 'warning', info: 'secondary' } as const;

/** The exceptions that pass a kind filter. */
export function filterExceptions(exceptions: readonly SalesTaxException[], kind: KindFilter): SalesTaxException[] {
  return kind === 'all' ? [...exceptions] : exceptions.filter((exception) => exception.kind === kind);
}

/** Documents whose sales tax needs a second look: no ship-to, tax in an unregistered state, taxable sales without tax and more. */
export function ExceptionsReport() {
  const { t } = useI18n();
  const te = t.weldbooksUs.salesTax.center.reports.exceptions;
  const tc = t.weldbooksUs.salesTax.center.common;
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const [range, setRange] = useState(() => {
    const now = today();
    return { from: startOfYear(now), to: now };
  });
  const [kind, setKind] = useState<KindFilter>('all');
  const query = useSalesTaxExceptionsReport({ from: range.from || undefined, to: range.to || undefined });
  const report = query.data;
  const kinds = te.kinds as Record<SalesTaxExceptionKind, string>;
  const severities = te.severities as Record<string, string>;
  const kindDescriptions = te.kindDescriptions as Partial<Record<SalesTaxExceptionKind, string>>;
  const rows = useMemo(() => (report ? filterExceptions(report.exceptions, kind) : []), [report, kind]);
  const total = report ? report.exceptions.length : 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{te.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter idPrefix="exceptions" from={range.from} to={range.to} onChange={setRange} />
      </div>
      {report ? (
        <p className="text-xs text-muted-foreground">
          {fill(tc.showingRange, { from: formatDate(report.from), to: formatDate(report.to) })}
        </p>
      ) : null}

      {report ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={te.kind}>
          <Button
            type="button"
            size="sm"
            variant={kind === 'all' ? 'default' : 'outline'}
            aria-pressed={kind === 'all'}
            onClick={() => setKind('all')}
          >
            {te.all} ({total})
          </Button>
          {EXCEPTION_KINDS.filter((value) => report.counts[value] > 0).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={kind === value ? 'default' : 'outline'}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {kinds[value]} ({report.counts[value]})
            </Button>
          ))}
        </div>
      ) : null}

      {query.isLoading ? (
        <RowsSkeleton rows={6} />
      ) : query.isError && !report ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : report && rows.length === 0 ? (
        <EmptyState icon={CircleCheck} title={te.empty} description={te.emptyDescription} />
      ) : report ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{te.kind}</TableHead>
                  <TableHead>{te.date}</TableHead>
                  <TableHead>{te.document}</TableHead>
                  <TableHead>{te.customer}</TableHead>
                  <TableHead>{te.state}</TableHead>
                  <TableHead className="text-right">{te.amount}</TableHead>
                  <TableHead className="text-right">{te.tax}</TableHead>
                  <TableHead>{te.message}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((exception, index) => (
                  <TableRow key={`${exception.kind}|${exception.documentId ?? ''}|${exception.date ?? ''}|${index}`} data-testid="exception-row">
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={SEVERITY_VARIANT[exception.severity]}>{severities[exception.severity]}</Badge>
                        <span className="font-medium">{kinds[exception.kind]}</span>
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(exception.date)}</TableCell>
                    <TableCell>
                      <DocumentLink type={exception.documentType} id={exception.documentId} number={exception.documentNumber} />
                    </TableCell>
                    <TableCell>{exception.contactName ?? '—'}</TableCell>
                    <TableCell>{exception.stateCode ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {exception.amount === null ? '—' : formatMoney(exception.amount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {exception.taxAmount === null ? '—' : formatMoney(exception.taxAmount)}
                    </TableCell>
                    <TableCell className="max-w-[26rem] whitespace-normal text-muted-foreground">{kindDescriptions[exception.kind] ?? exception.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
