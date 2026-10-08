import { useState } from 'react';
import { CircleCheck, PlugZap } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
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
import { useProviderReconciliation } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { ReconciliationStatus } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DateRangeFilter } from '../shared/date-range';
import { DocumentLink } from '../shared/document-link';
import { Notice } from '../shared/notice';
import { EmptyState, ErrorState, RowsSkeleton } from '../shared/query-states';
import { fill, toCents } from '../shared/text';

const STATUS_VARIANT: Record<ReconciliationStatus, 'success' | 'secondary' | 'destructive' | 'warning'> = {
  ok: 'success',
  not_committed: 'secondary',
  missing_commit: 'destructive',
  commit_failed: 'destructive',
  ledger_mismatch: 'destructive',
  no_ledger: 'destructive',
};

/** Statuses whose server message names something specific (a failure text, the amounts) rather than repeating the status. */
const MESSAGE_STATUSES: readonly ReconciliationStatus[] = ['commit_failed'];

/** The tax a provider engine calculated for each invoice against the tax ledger, by month and by document. */
export function ProviderReconciliationReport() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.salesTax.center.reports.providerReconciliation;
  const tc = t.weldbooksUs.salesTax.center.common;
  const { formatMoney, formatDate, formatDateTime, formatMonth } = useWeldbooksFormat();
  // Empty dates: the server answers for the last month.
  const [range, setRange] = useState({ from: '', to: '' });
  const [all, setAll] = useState(false);
  const query = useProviderReconciliation({ from: range.from || undefined, to: range.to || undefined, all });
  const report = query.data;
  const statuses = tp.statuses as Record<ReconciliationStatus, string>;
  const engines = tp.engines as Record<string, string>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{tp.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter
          idPrefix="reconciliation"
          from={range.from}
          to={range.to}
          onChange={setRange}
        />
        <div className="flex items-center gap-2 pb-2">
          <Switch id="reconciliation-all" checked={all} onCheckedChange={setAll} />
          <Label htmlFor="reconciliation-all">{tp.showAll}</Label>
        </div>
      </div>

      {query.isLoading ? (
        <RowsSkeleton rows={5} />
      ) : query.isError && !report ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : report && !report.applicable ? (
        <EmptyState icon={PlugZap} title={tp.notApplicableTitle} description={tp.notApplicableDescription} />
      ) : report ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{tp.engine}:</span>
            <Badge variant="outline">{engines[report.engine] ?? report.engine}</Badge>
            <span className="text-xs text-muted-foreground">
              {fill(tc.showingRange, { from: formatDate(report.from), to: formatDate(report.to) })}
            </span>
          </div>
          <Notice tone="info">
            <p>{tp.note}</p>
          </Notice>

          {report.periods.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{tp.byMonth}</h3>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tp.month}</TableHead>
                        <TableHead className="text-right">{tp.documents}</TableHead>
                        <TableHead className="text-right">{tp.committed}</TableHead>
                        <TableHead className="text-right">{tp.uncommitted}</TableHead>
                        <TableHead className="text-right">{tp.providerTax}</TableHead>
                        <TableHead className="text-right">{tp.ledgerTax}</TableHead>
                        <TableHead className="text-right">{tp.difference}</TableHead>
                        <TableHead className="text-right">{tp.problems}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.periods.map((period) => (
                        <TableRow key={period.period} data-testid="reconciliation-period">
                          <TableCell className="font-medium">{formatMonth(`${period.period}-01`)}</TableCell>
                          <TableCell className="text-right tabular-nums">{period.documents}</TableCell>
                          <TableCell className="text-right tabular-nums">{period.committed}</TableCell>
                          <TableCell className="text-right tabular-nums">{period.uncommitted}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(period.providerTax)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(period.ledgerTax)}</TableCell>
                          <TableCell
                            className={cn('text-right tabular-nums', toCents(period.difference) !== 0 && 'font-medium text-destructive')}
                          >
                            {formatMoney(period.difference)}
                          </TableCell>
                          <TableCell
                            className={cn('text-right tabular-nums', period.problems > 0 && 'font-medium text-destructive')}
                          >
                            {period.problems}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {report.documents.length === 0 ? (
            <EmptyState icon={CircleCheck} title={tp.allMatch} description={tp.allMatchDescription} />
          ) : (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{tp.documentsTitle}</h3>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{tp.date}</TableHead>
                        <TableHead>{tp.document}</TableHead>
                        <TableHead>{tp.engineRef}</TableHead>
                        <TableHead>{tp.committedAt}</TableHead>
                        <TableHead className="text-right">{tp.providerTax}</TableHead>
                        <TableHead className="text-right">{tp.ledgerTax}</TableHead>
                        <TableHead className="text-right">{tp.difference}</TableHead>
                        <TableHead>{tp.status}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.documents.map((document) => (
                        <TableRow key={`${document.documentType}-${document.documentId}`} data-testid="reconciliation-document">
                          <TableCell>{formatDate(document.date)}</TableCell>
                          <TableCell>
                            <DocumentLink
                              type={document.documentType}
                              id={document.documentId}
                              number={document.documentNumber}
                            />
                          </TableCell>
                          <TableCell className="max-w-[12rem] truncate">{document.engineRef ?? '—'}</TableCell>
                          <TableCell>{document.committedAt ? formatDateTime(document.committedAt) : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(document.providerTax)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(document.ledgerTax)}</TableCell>
                          <TableCell
                            className={cn('text-right tabular-nums', toCents(document.difference) !== 0 && 'font-medium text-destructive')}
                          >
                            {formatMoney(document.difference)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={STATUS_VARIANT[document.status]}>{statuses[document.status]}</Badge>
                            {MESSAGE_STATUSES.includes(document.status) && document.message ? (
                              <span className="mt-1 block max-w-[18rem] whitespace-normal text-xs text-muted-foreground">
                                {document.message}
                              </span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
