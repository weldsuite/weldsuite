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
import { useBalanceSheetReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

interface BalanceSheetAccountRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  balance: string | number | null;
}

interface BalanceSheetReport {
  assets?: BalanceSheetAccountRow[];
  liabilities?: BalanceSheetAccountRow[];
  equity?: BalanceSheetAccountRow[];
  totalAssets?: string | number | null;
  totalLiabilities?: string | number | null;
  totalEquity?: string | number | null;
}

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

function AccountSection({
  title,
  accounts,
  total,
  totalLabel,
}: {
  title: string;
  accounts: BalanceSheetAccountRow[] | undefined;
  total: string | number | null | undefined;
  totalLabel: string;
}) {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr.account}</TableHead>
              <TableHead className="text-right">{tr.colBalance}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(accounts ?? []).map((a) => (
              <TableRow key={a.accountId}>
                <TableCell>{a.accountCode} — {a.accountName}</TableCell>
                <TableCell className="text-right">{fmt(a.balance)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell className="font-semibold">{totalLabel}</TableCell>
              <TableCell className="text-right font-semibold">{fmt(total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function BalanceSheetReportPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const { data, isLoading, refetch } = useBalanceSheetReport({ asOf });
  const report = data?.data as BalanceSheetReport | undefined;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.balanceSheet}</h1>

      <div className="flex items-end gap-4">
        <div className="space-y-2">
          <Label>{tr.asOf}</Label>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <Button onClick={() => refetch()} disabled={isLoading}>
          {isLoading ? tr.loading : tr.generate}
        </Button>
      </div>

      {report && (
        <div className="space-y-4">
          <AccountSection
            title={tr.assets}
            accounts={report.assets}
            total={report.totalAssets}
            totalLabel={`${tr.totalPrefix} ${tr.assets}`}
          />
          <AccountSection
            title={tr.liabilities}
            accounts={report.liabilities}
            total={report.totalLiabilities}
            totalLabel={`${tr.totalPrefix} ${tr.liabilities}`}
          />
          <AccountSection
            title={tr.equity}
            accounts={report.equity}
            total={report.totalEquity}
            totalLabel={`${tr.totalPrefix} ${tr.equity}`}
          />
        </div>
      )}
    </div>
  );
}
