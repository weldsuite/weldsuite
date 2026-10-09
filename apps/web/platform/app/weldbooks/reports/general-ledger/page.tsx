import { useMemo, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useAccountingAccounts, useGeneralLedgerReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { ReportParams } from '../components/report-model';
import { ReportShell } from '../components/report-shell';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportHeadings } from '../components/use-report-headings';
import { useReportParams } from '../components/use-report-params';

const PAGE_SIZE = 50;

export default function GeneralLedgerReportPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const tb = t.accounting.reports;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const search = useSearch({ from: '/weldbooks/reports/general-ledger/' });
  const { params, update, query } = useReportParams({ from: search.from ?? '', to: search.to ?? '' });
  const [accountId, setAccountId] = useState(search.accountId ?? '');
  const [page, setPage] = useState(1);
  const { rangeLabel } = useReportHeadings();

  const accountsQuery = useAccountingAccounts();
  const accounts = useMemo(
    () => [...(accountsQuery.data?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })),
    [accountsQuery.data],
  );

  const reportQuery = useGeneralLedgerReport({ ...query, accountId, page, pageSize: PAGE_SIZE });
  const report = reportQuery.data;
  const periodLabel = report ? rangeLabel(report.period.from, report.period.to) : undefined;

  // The export covers every line of the period, so it asks without a page.
  const { busy, exportCsv, exportPdf } = useReportExport('general-ledger', { ...query, accountId }, { periodLabel });

  const change = (patch: Partial<ReportParams>) => {
    setPage(1);
    update(patch);
  };

  const balanceClass = (value: string) => (Number(value) < 0 ? 'text-red-600 dark:text-red-400' : undefined);

  const accountPicker = (
    <div className="min-w-64 space-y-1.5">
      <Label htmlFor="report-account">{tb.account}</Label>
      <Select
        value={accountId}
        onValueChange={(value) => {
          setAccountId(value);
          setPage(1);
        }}
      >
        <SelectTrigger id="report-account" className="w-72">
          <SelectValue placeholder={tb.selectAccount} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.code} — {account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const toolbar = (
    <ReportToolbar
      dates="period"
      params={params}
      onChange={change}
      defaults={{ from: report?.period.from, to: report?.period.to, basis: report?.basis }}
      showCompare={false}
      isFetching={reportQuery.isFetching && !reportQuery.isLoading}
      exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !report }}
    >
      {accountPicker}
    </ReportToolbar>
  );

  return (
    <ReportShell
      title={tb.generalLedger}
      subtitle={
        report
          ? `${report.account.code} ${report.account.name} · ${periodLabel} · ${report.basis === 'cash' ? tr.basisCash : tr.basisAccrual}`
          : undefined
      }
      toolbar={toolbar}
      isLoading={!!accountId && reportQuery.isLoading}
      isError={!!accountId && reportQuery.isError && !report}
      onRetry={() => void reportQuery.refetch()}
    >
      {!accountId || !report ? (
        <p className="rounded-md border p-8 text-center text-sm text-muted-foreground">{tr.selectAccountFirst}</p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              { label: tb.openingBalance, value: report.openingBalance, signed: true },
              { label: tb.totalDebits, value: report.totalDebit, signed: false },
              { label: tb.totalCredits, value: report.totalCredit, signed: false },
              { label: tb.closingBalance, value: report.closingBalance, signed: true },
            ].map((item) => (
              <Card key={item.label}>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">{item.label}</p>
                  <p className={cn('text-lg font-semibold tabular-nums', item.signed && balanceClass(item.value))}>
                    {formatMoney(item.value)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <caption className="sr-only">{tb.transactions}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>{tb.colDate}</TableHead>
                  <TableHead>{tb.colEntryNumber}</TableHead>
                  <TableHead>{tb.colDescription}</TableHead>
                  <TableHead className="text-right">{tb.debit}</TableHead>
                  <TableHead className="text-right">{tb.credit}</TableHead>
                  <TableHead className="text-right">{tb.colBalance}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={5} className="font-medium">{tb.openingBalance}</TableCell>
                  <TableCell className={cn('text-right font-medium tabular-nums', balanceClass(report.openingBalance))}>
                    {formatMoney(report.openingBalance)}
                  </TableCell>
                </TableRow>
                {report.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="whitespace-nowrap">{formatDate(line.entryDate)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {line.journalEntryId && line.entryNumber ? (
                        <Link
                          to="/weldbooks/journal/$id"
                          params={{ id: line.journalEntryId }}
                          className="hover:underline"
                        >
                          {line.entryNumber}
                        </Link>
                      ) : (
                        (line.entryNumber ?? '-')
                      )}
                    </TableCell>
                    <TableCell>{line.description ?? '-'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(line.debit) !== 0 ? formatMoney(line.debit) : '-'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(line.credit) !== 0 ? formatMoney(line.credit) : '-'}
                    </TableCell>
                    <TableCell className={cn('text-right font-medium tabular-nums', balanceClass(line.runningBalance))}>
                      {formatMoney(line.runningBalance)}
                    </TableCell>
                  </TableRow>
                ))}
                {report.lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      {tb.noTransactionsInPeriod}
                    </TableCell>
                  </TableRow>
                ) : null}
                <TableRow className="border-t-2 bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={3} className="font-semibold">{tb.closingBalance}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(report.totalDebit)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(report.totalCredit)}</TableCell>
                  <TableCell className={cn('text-right font-semibold tabular-nums', balanceClass(report.closingBalance))}>
                    {formatMoney(report.closingBalance)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>{tr.balanceNote}</p>
            <div className="flex items-center gap-2">
              <span>
                {tr.pageOf
                  .replace('{page}', String(report.pagination.page))
                  .replace('{total}', String(Math.max(report.pagination.totalPages, 1)))
                  .replace('{count}', String(report.pagination.totalCount))}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={report.pagination.page <= 1 || reportQuery.isFetching}
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
              >
                {tr.previous}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!report.pagination.hasMore || reportQuery.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                {tr.next}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ReportShell>
  );
}
