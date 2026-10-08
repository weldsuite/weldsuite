import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, FileSearch, Loader2 } from 'lucide-react';
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
import { useI18n } from '@/lib/i18n/provider';
import { useReturnDocuments } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { ReturnDocument } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DocumentLink } from '../../shared/document-link';
import { EmptyState, ErrorState, RowsSkeleton } from '../../shared/query-states';
import { fill } from '../../shared/text';

interface DocumentRowsProps {
  document: ReturnDocument;
}

/** The jurisdiction rows a document contributed to the return. */
function DocumentRows({ document }: Readonly<DocumentRowsProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.salesTax.center.returnPage.documents;
  const levels = t.weldbooksUs.salesTax.center.levels as Record<string, string>;
  const reasons = t.weldbooksUs.salesTax.center.exemptReasons as Record<string, string>;
  const { formatMoney } = useWeldbooksFormat();
  const certificates = new Map(document.certificates.map((certificate) => [certificate.id, certificate]));

  return (
    <div className="rounded-md border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{td.location}</TableHead>
            <TableHead>{td.level}</TableHead>
            <TableHead>{td.reportingCode}</TableHead>
            <TableHead className="text-right">{td.rate}</TableHead>
            <TableHead className="text-right">{td.taxableSales}</TableHead>
            <TableHead className="text-right">{td.exemptSales}</TableHead>
            <TableHead className="text-right">{td.nonTaxableSales}</TableHead>
            <TableHead className="text-right">{document.rows.some((row) => row.kind === 'use') ? td.useTax : td.tax}</TableHead>
            <TableHead>{td.certificate}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {document.rows.map((row) => {
            const certificate = row.certificateId ? certificates.get(row.certificateId) : undefined;
            return (
              <TableRow key={row.taxLineId}>
                <TableCell>
                  <span className="font-medium">{row.jurisdictionName || row.jurisdictionCode || '—'}</span>
                  {row.shipToState ? <span className="ml-2 text-xs text-muted-foreground">{row.shipToState}</span> : null}
                  {row.marketplaceFacilitated ? (
                    <Badge variant="outline" className="ml-2">
                      {td.marketplace}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{row.jurisdictionLevel ? (levels[row.jurisdictionLevel] ?? row.jurisdictionLevel) : '—'}</TableCell>
                <TableCell>{row.reportingCode || '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(row.rate.toFixed(4))}%</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(row.taxableAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.exemptAmount)}
                  {row.exemptReason && row.exemptAmount !== 0 ? (
                    <span className="block text-xs text-muted-foreground">{reasons[row.exemptReason] ?? row.exemptReason}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(row.nonTaxableAmount)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.taxAmount)}
                  {row.share !== 1 ? (
                    <span className="block text-xs text-muted-foreground">
                      {fill(td.share, { percent: Math.round(row.share * 100) })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {row.exemptAmount === 0 && !row.certificateId ? (
                    '—'
                  ) : certificate ? (
                    <span className="text-xs">
                      {fill(td.certificateNumber, { number: certificate.certificateNumber ?? certificate.id })}
                    </span>
                  ) : row.certificateId ? (
                    <span className="text-xs">{row.certificateId}</span>
                  ) : (
                    <span className="text-xs text-destructive">{td.noCertificate}</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

interface DocumentsCardProps {
  returnId: string;
  /** Load the documents (the tab is open). */
  enabled: boolean;
}

/** The documents behind the return, a page at a time, each expandable to its jurisdiction rows. */
export function DocumentsCard({ returnId, enabled }: Readonly<DocumentsCardProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.salesTax.center.returnPage.documents;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const query = useReturnDocuments(returnId, { enabled });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const documents = query.data?.pages.flatMap((page) => page.data) ?? [];
  const total = query.data?.pages[0]?.pagination.totalCount ?? 0;

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card data-testid="documents-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{td.title}</CardTitle>
        <p className="text-xs text-muted-foreground">{td.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <RowsSkeleton rows={5} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : documents.length === 0 ? (
          <EmptyState icon={FileSearch} title={td.empty} description={td.emptyHint} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <span className="sr-only">{t.weldbooksUs.salesTax.center.common.details}</span>
                  </TableHead>
                  <TableHead>{td.date}</TableHead>
                  <TableHead>{td.document}</TableHead>
                  <TableHead>{td.counterparty}</TableHead>
                  <TableHead className="text-right">{td.grossSales}</TableHead>
                  <TableHead className="text-right">{td.taxableSales}</TableHead>
                  <TableHead className="text-right">{td.exemptSales}</TableHead>
                  <TableHead className="text-right">{td.nonTaxableSales}</TableHead>
                  <TableHead className="text-right">{td.tax}</TableHead>
                  <TableHead className="text-right">{td.useTax}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((document) => {
                  const isOpen = expanded.has(document.key);
                  return (
                    <Fragment key={document.key}>
                      <TableRow data-testid="document-row">
                        <TableCell className="w-8 pr-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? td.hideRows : td.showRows}
                            onClick={() => toggle(document.key)}
                          >
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell>{formatDate(document.taxDate)}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            <DocumentLink
                              type={document.document.type}
                              id={document.document.id}
                              number={document.document.number}
                            />
                            {document.carried ? <Badge variant="outline">{td.carried}</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate">
                          {document.document.contactName ?? document.document.description ?? '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(document.grossSales)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(document.taxableSales)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(document.exemptSales)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(document.nonTaxableSales)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(document.tax)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(document.useTax)}</TableCell>
                      </TableRow>
                      {isOpen ? (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={10} className="whitespace-normal p-3">
                            <DocumentRows document={document} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{fill(td.showing, { shown: documents.length, total })}</p>
              {query.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {td.loadMore}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
