import { PageLoader } from '@/components/page-loader';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useAgedReceivablesReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export default function AgedReceivablesReportPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const { data, isLoading } = useAgedReceivablesReport();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const report = data?.data as any;

  const buckets: Array<{ key: string; label: string }> = [
    { key: 'current', label: tr.bucketCurrent },
    { key: '1_30', label: tr.bucket1_30 },
    { key: '31_60', label: tr.bucket31_60 },
    { key: '61_90', label: tr.bucket61_90 },
    { key: 'over_90', label: tr.bucketOver90 },
  ];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.agedReceivables}</h1>

      {report ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {buckets.map(({ key, label }) => (
              <Card key={key}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-lg font-semibold">{fmt(report.buckets?.[key])}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr.colInvoice}</TableHead>
                    <TableHead>{tr.colContact}</TableHead>
                    <TableHead>{tr.colDueDate}</TableHead>
                    <TableHead>{tr.colDaysOverdue}</TableHead>
                    <TableHead className="text-right">{tr.colBalanceDue}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(report.invoices ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {tr.noOutstandingReceivables}
                      </TableCell>
                    </TableRow>
                  ) : (
                    (report.invoices ?? []).map((inv: any) => (
                      <TableRow key={inv.id}>
                        <TableCell>{inv.invoiceNumber}</TableCell>
                        <TableCell>{inv.contactName}</TableCell>
                        <TableCell>{inv.dueDate}</TableCell>
                        <TableCell>{inv.daysOverdue}</TableCell>
                        <TableCell className="text-right">{fmt(inv.balanceDue)}</TableCell>
                      </TableRow>
                    ))
                  )}
                  <TableRow>
                    <TableCell colSpan={4} className="font-semibold">{tr.total}</TableCell>
                    <TableCell className="text-right font-semibold">{fmt(report.total)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : (
        <p className="text-muted-foreground">{tr.noData}</p>
      )}
    </div>
  );
}
