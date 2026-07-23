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
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export default function CashFlowReportPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const today = new Date();
  const startOfYear = `${today.getFullYear()}-01-01`;
  const [from, setFrom] = useState(startOfYear);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['accounting', 'reports', 'cash-flow', { from, to }],
    queryFn: () => accountingApi.getCashFlow({ from, to }),
    enabled: false,
  });

  const report = data?.data as any;

  let runningBalance = 0;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.cashFlow}</h1>

      <div className="flex items-end gap-4">
        <div className="space-y-2">
          <Label>{tr.from}</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{tr.to}</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button onClick={() => refetch()} disabled={isLoading}>
          {isLoading ? tr.loading : tr.generate}
        </Button>
      </div>

      {isLoading && <PageLoader fullScreen={false} />}

      {report && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">{tr.totalInflows}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-green-600">
                  {fmt(report.totalInflows)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">{tr.totalOutflows}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-red-600">
                  {fmt(report.totalOutflows)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">{tr.netCashFlow}</CardTitle>
              </CardHeader>
              <CardContent>
                <p
                  className={`text-2xl font-semibold ${Number(report.netCashFlow ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}
                >
                  {fmt(report.netCashFlow)}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tr.monthlyBreakdown}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr.colMonth}</TableHead>
                    <TableHead className="text-right">{tr.colInflows}</TableHead>
                    <TableHead className="text-right">{tr.colOutflows}</TableHead>
                    <TableHead className="text-right">{tr.colNet}</TableHead>
                    <TableHead className="text-right">{tr.colRunningBalance}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(report.months ?? []).map((m: any) => {
                    const net = Number(m.net ?? 0);
                    runningBalance += net;
                    return (
                      <TableRow key={m.month}>
                        <TableCell>{m.month}</TableCell>
                        <TableCell className="text-right text-green-600">
                          {fmt(m.inflows)}
                        </TableCell>
                        <TableCell className="text-right text-red-600">
                          {fmt(m.outflows)}
                        </TableCell>
                        <TableCell
                          className={`text-right ${net >= 0 ? 'text-green-600' : 'text-red-600'}`}
                        >
                          {fmt(m.net)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-medium ${runningBalance >= 0 ? 'text-green-600' : 'text-red-600'}`}
                        >
                          {fmt(runningBalance)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
