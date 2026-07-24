import { useState } from 'react';
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
import { useProfitLossReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

interface ProfitLossAccountRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  total: string | number | null;
}

interface ProfitLossReport {
  revenue?: ProfitLossAccountRow[];
  expenses?: ProfitLossAccountRow[];
  totalRevenue?: string | number | null;
  totalExpenses?: string | number | null;
  netProfit?: string | number | null;
}

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export default function ProfitLossReportPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const today = new Date();
  const startOfYear = `${today.getFullYear()}-01-01`;
  const [from, setFrom] = useState(startOfYear);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));

  const { data, isLoading, refetch } = useProfitLossReport({ from, to });
  const report = data?.data as ProfitLossReport | undefined;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.profitLoss}</h1>

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

      {report && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tr.revenue}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr.account}</TableHead>
                    <TableHead className="text-right">{tr.amount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(report.revenue ?? []).map((r) => (
                    <TableRow key={r.accountId}>
                      <TableCell>{r.accountCode} — {r.accountName}</TableCell>
                      <TableCell className="text-right">{fmt(r.total)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="font-semibold">{tr.totalRevenue}</TableCell>
                    <TableCell className="text-right font-semibold">{fmt(report.totalRevenue)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tr.expenses}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr.account}</TableHead>
                    <TableHead className="text-right">{tr.amount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(report.expenses ?? []).map((e) => (
                    <TableRow key={e.accountId}>
                      <TableCell>{e.accountCode} — {e.accountName}</TableCell>
                      <TableCell className="text-right">{fmt(e.total)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="font-semibold">{tr.totalExpenses}</TableCell>
                    <TableCell className="text-right font-semibold">{fmt(report.totalExpenses)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex justify-between text-lg font-semibold">
                <span>{tr.netProfitLoss}</span>
                <span className={Number(report.netProfit ?? 0) < 0 ? 'text-destructive' : ''}>
                  {fmt(report.netProfit)}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
