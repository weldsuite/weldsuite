import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export default function GeneralLedgerReportPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const today = new Date();
  const startOfYear = `${today.getFullYear()}-01-01`;
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(startOfYear);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data: accountsData } = useQuery({
    queryKey: ['accounting', 'accounts', 'list-all'],
    queryFn: () => accountingApi.listAccounts(),
  });

  const accounts = (accountsData?.data as any[]) ?? [];

  const {
    data,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['accounting', 'reports', 'general-ledger', { accountId, from, to, page, pageSize }],
    queryFn: () =>
      accountingApi.getGeneralLedger({ accountId, from, to, page, pageSize }),
    enabled: false,
  });

  const report = data?.data as any;

  const handleGenerate = () => {
    if (!accountId) return;
    setPage(1);
    refetch();
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.generalLedger}</h1>

      <div className="flex items-end gap-4 flex-wrap">
        <div className="space-y-2 min-w-[250px]">
          <Label>{tr.account}</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger>
              <SelectValue placeholder={tr.selectAccount} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a: any) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{tr.from}</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{tr.to}</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button onClick={handleGenerate} disabled={isLoading || !accountId}>
          {isLoading ? tr.loading : tr.generate}
        </Button>
      </div>

      {isLoading && <PageLoader fullScreen={false} />}

      {report && (
        <div className="space-y-6">
          {report.account && (
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium">
                    {report.account.code} — {report.account.name}
                  </span>
                  <span className="text-muted-foreground">
                    {tr.accountType} {report.account.type}
                    {report.account.subtype ? ` / ${report.account.subtype}` : ''}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tr.transactions}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr.colDate}</TableHead>
                    <TableHead>{tr.colEntryNumber}</TableHead>
                    <TableHead>{tr.colDescription}</TableHead>
                    <TableHead className="text-right">{tr.debit}</TableHead>
                    <TableHead className="text-right">{tr.credit}</TableHead>
                    <TableHead className="text-right">{tr.colBalance}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(report.lines ?? []).map((line: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell>{line.date}</TableCell>
                      <TableCell>{line.entryNumber ?? '-'}</TableCell>
                      <TableCell>{line.description ?? '-'}</TableCell>
                      <TableCell className="text-right">
                        {Number(line.debit ?? 0) > 0 ? fmt(line.debit) : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(line.credit ?? 0) > 0 ? fmt(line.credit) : '-'}
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium ${Number(line.runningBalance ?? 0) < 0 ? 'text-red-600' : ''}`}
                      >
                        {fmt(line.runningBalance)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(report.lines ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        {tr.noTransactionsInPeriod}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {report.totals && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tr.summary}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">{tr.openingBalance}</p>
                    <p className="text-lg font-semibold">{fmt(report.totals.openingBalance)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{tr.totalDebits}</p>
                    <p className="text-lg font-semibold">{fmt(report.totals.totalDebits)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{tr.totalCredits}</p>
                    <p className="text-lg font-semibold">{fmt(report.totals.totalCredits)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{tr.closingBalance}</p>
                    <p
                      className={`text-lg font-semibold ${Number(report.totals.closingBalance ?? 0) < 0 ? 'text-red-600' : ''}`}
                    >
                      {fmt(report.totals.closingBalance)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
