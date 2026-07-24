import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useTrialBalanceReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

interface TrialBalanceAccountRow {
  accountId?: string;
  accountCode: string;
  accountName: string;
  debit: string | number | null;
  credit: string | number | null;
}

interface TrialBalanceReport {
  accounts?: TrialBalanceAccountRow[];
  totalDebit?: string | number | null;
  totalCredit?: string | number | null;
}

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

export default function TrialBalanceReportPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const today = new Date();
  const [from, setFrom] = useState(`${today.getFullYear()}-01-01`);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const { data, isLoading, refetch } = useTrialBalanceReport({ from, to });
  const report = data?.data as TrialBalanceReport | undefined;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.trialBalance}</h1>

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
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr.code}</TableHead>
                  <TableHead>{tr.account}</TableHead>
                  <TableHead className="text-right">{tr.debit}</TableHead>
                  <TableHead className="text-right">{tr.credit}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(report.accounts ?? []).map((a) => (
                  <TableRow key={a.accountId}>
                    <TableCell className="font-mono">{a.accountCode}</TableCell>
                    <TableCell>{a.accountName}</TableCell>
                    <TableCell className="text-right">
                      {Number(a.debit) > 0 ? fmt(a.debit) : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {Number(a.credit) > 0 ? fmt(a.credit) : '-'}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={2} className="font-semibold">{tr.totals}</TableCell>
                  <TableCell className="text-right font-semibold">{fmt(report.totalDebit)}</TableCell>
                  <TableCell className="text-right font-semibold">{fmt(report.totalCredit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
