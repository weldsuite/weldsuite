import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { usePayrollImport } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { toCents } from '../../fixed-assets/asset-math';
import { fill } from '../../fixed-assets/text';
import { ReversePayrollDialog } from '../components/reverse-dialog';

/** One imported payroll: where it came from, what it totals and the journal entry it posted. */
export default function PayrollImportDetailPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const { t } = useI18n();
  const tp = t.weldbooksUs.assets.payroll;
  const td = tp.detail;
  const common = t.weldbooksUs.assets.common;
  const { can } = usePermissions();
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();
  const { data: payroll, isLoading, isError, refetch } = usePayrollImport(id);
  const [reversing, setReversing] = useState(false);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (isError) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-destructive" role="alert">
          {td.loadFailed}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {common.retry}
        </Button>
      </div>
    );
  }
  if (!payroll) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-muted-foreground">{td.notFound}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/weldbooks/payroll">{td.back}</Link>
        </Button>
      </div>
    );
  }

  const categories = tp.categories as Record<string, string>;
  const summary = Object.entries(payroll.summary ?? {}).filter(([, value]) => value !== 0);
  const totalDebit = payroll.lines.reduce((sum, line) => sum + toCents(line.debit), 0) / 100;
  const totalCredit = payroll.lines.reduce((sum, line) => sum + toCents(line.credit), 0) / 100;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" asChild aria-label={td.back}>
            <Link to="/weldbooks/payroll">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{fill(td.title, { date: formatDate(payroll.payDate) })}</h1>
              <Badge variant={payroll.status === 'posted' ? 'success' : 'secondary'}>{tp.statuses[payroll.status]}</Badge>
              <Badge variant="outline">{tp.sources[payroll.source]}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {payroll.periodStart && payroll.periodEnd ? `${formatDate(payroll.periodStart)} – ${formatDate(payroll.periodEnd)}` : null}
              {payroll.sourceFileName ? ` · ${payroll.sourceFileName}` : ''}
              {` · ${fill(td.imported, { date: formatDateTime(payroll.createdAt) })}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {payroll.journalEntryId ? (
            <Button variant="outline" asChild>
              <Link to="/weldbooks/journal/$id" params={{ id: payroll.journalEntryId }}>
                {td.viewEntry}
              </Link>
            </Button>
          ) : null}
          {payroll.status === 'posted' && can('journal:delete') ? (
            <Button variant="outline" onClick={() => setReversing(true)} data-testid="reverse-open">
              {td.reverse}
            </Button>
          ) : null}
        </div>
      </div>

      {payroll.status === 'reversed' ? <p className="text-sm text-muted-foreground">{td.reversedNote}</p> : null}

      {summary.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.summary}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              {summary.map(([key, value]) => (
                <div key={key} className="flex justify-between gap-3 border-b py-1.5 last:border-b-0">
                  <dt className="text-muted-foreground">{categories[key] ?? key}</dt>
                  <dd className="font-medium tabular-nums">{formatMoney(value)}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{td.lines}</CardTitle>
        </CardHeader>
        <CardContent>
          {payroll.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{td.noLines}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{td.columns.account}</TableHead>
                    <TableHead>{td.columns.memo}</TableHead>
                    <TableHead className="text-right">{td.columns.debit}</TableHead>
                    <TableHead className="text-right">{td.columns.credit}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payroll.lines.map((line, index) => (
                    <TableRow key={`${line.accountId}-${index}`}>
                      <TableCell>
                        <Link to="/weldbooks/accounts/$id" params={{ id: line.accountId }} className="underline-offset-2 hover:underline">
                          {line.accountCode} — {line.accountName}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[320px] truncate text-muted-foreground">{line.description ?? ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(line.debit) ? formatMoney(line.debit) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(line.credit) ? formatMoney(line.credit) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{common.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(totalDebit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(totalCredit)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {reversing ? (
        <ReversePayrollDialog payroll={payroll} open onOpenChange={(open) => setReversing(open)} />
      ) : null}
    </div>
  );
}
