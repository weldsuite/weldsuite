import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { AGING_BUCKETS, type AgedReport, type AgingBucket } from '@/lib/weldbooks/report-types';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { bucketCount, bucketTotal } from './report-model';

interface AgedReportViewProps {
  report: AgedReport;
  kind: 'receivables' | 'payables';
}

/**
 * Open invoices (receivables) or bills (payables) by age: a card per bucket,
 * the buckets per customer or vendor, and the documents behind them.
 */
export function AgedReportView({ report, kind }: Readonly<AgedReportViewProps>) {
  const { t } = useI18n();
  const tb = t.accounting.reports;
  const tr = t.weldbooksUs.reports;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const receivables = kind === 'receivables';

  const bucketLabels: Record<AgingBucket, string> = {
    current: tb.bucketCurrent,
    '1-30': tb.bucket1_30,
    '31-60': tb.bucket31_60,
    '61-90': tb.bucket61_90,
    '90+': tb.bucketOver90,
  };
  const contactLabel = receivables ? tb.colContact : labels.supplier;
  const documentLabel = receivables ? tb.colInvoice : tb.colBill;

  if (report.documents.length === 0) {
    return (
      <p className="rounded-md border p-8 text-center text-sm text-muted-foreground">
        {receivables ? tb.noOutstandingReceivables : tb.noOutstandingPayables}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {AGING_BUCKETS.map((bucket) => {
          const count = bucketCount(report.buckets[bucket], report.bucketCounts, bucket);
          return (
            <Card key={bucket}>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">{bucketLabels[bucket]}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold tabular-nums">{formatMoney(bucketTotal(report.buckets[bucket]))}</p>
                {count !== null ? (
                  <p className="text-xs text-muted-foreground">{tr.documentsCount.replace('{count}', String(count))}</p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <section aria-labelledby="aged-contacts" className="space-y-2">
        <h2 id="aged-contacts" className="text-base font-semibold">
          {tr.byContact.replace('{contact}', contactLabel)}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <caption className="sr-only">{tr.byContact.replace('{contact}', contactLabel)}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{contactLabel}</TableHead>
                {AGING_BUCKETS.map((bucket) => (
                  <TableHead key={bucket} className="whitespace-nowrap text-right">{bucketLabels[bucket]}</TableHead>
                ))}
                <TableHead className="text-right">{tb.total}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.contacts.map((contact) => (
                <TableRow key={contact.contactId}>
                  <TableCell>{contact.contactName ?? contact.contactId}</TableCell>
                  {AGING_BUCKETS.map((bucket) => (
                    <TableCell key={bucket} className="text-right tabular-nums">
                      {Number(contact[bucket]) !== 0 ? formatMoney(contact[bucket]) : '-'}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium tabular-nums">{formatMoney(contact.total)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 bg-muted/40 hover:bg-muted/40">
                <TableCell className="font-semibold">{tb.total}</TableCell>
                {AGING_BUCKETS.map((bucket) => (
                  <TableCell key={bucket} className="text-right font-semibold tabular-nums">
                    {formatMoney(bucketTotal(report.buckets[bucket]))}
                  </TableCell>
                ))}
                <TableCell className="text-right font-semibold tabular-nums">{formatMoney(report.total)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-labelledby="aged-documents" className="space-y-2">
        <h2 id="aged-documents" className="text-base font-semibold">{tr.openDocuments}</h2>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <caption className="sr-only">{tr.openDocuments}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{documentLabel}</TableHead>
                <TableHead>{contactLabel}</TableHead>
                <TableHead>{tb.colDueDate}</TableHead>
                <TableHead className="text-right">{tb.colDaysOverdue}</TableHead>
                <TableHead className="text-right">{tb.colBalanceDue}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="whitespace-nowrap">
                    {receivables ? (
                      <Link to="/weldbooks/invoices/$id" params={{ id: doc.id }} className="hover:underline">
                        {doc.number ?? doc.id}
                      </Link>
                    ) : (
                      <Link to="/weldbooks/bills/$id" params={{ id: doc.id }} className="hover:underline">
                        {doc.number ?? doc.id}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{doc.contactName ?? doc.contactId}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(doc.dueDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Math.max(doc.daysPastDue, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(doc.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
