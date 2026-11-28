'use client';

import { Coins } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { adminCopy } from '@/lib/i18n';
import { formatCredits, formatDateTime, formatDay } from '@/lib/billing-format';
import { cn } from '@/lib/utils';
import type { CreditsSummary } from '@/lib/billing-types';

export function CreditsCard({ credits }: Readonly<{ credits: CreditsSummary }>) {
  const t = adminCopy();

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">{t.credits.title}</h2>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat label={t.credits.balance} value={formatCredits(credits.balance)} negative={credits.balance < 0} />
          <Stat label={t.credits.monthly} value={formatCredits(credits.monthlyAllocation)} />
          <Stat label={t.credits.periodEnds} value={formatDay(credits.periodEnd)} />
        </div>

        <div>
          <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{t.credits.ledger}</h3>
          {credits.transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.credits.empty}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-44">{t.credits.columns.date}</TableHead>
                    <TableHead className="w-36">{t.credits.columns.type}</TableHead>
                    <TableHead className="w-28 text-right">{t.credits.columns.amount}</TableHead>
                    <TableHead className="w-28 text-right">{t.credits.columns.balance}</TableHead>
                    <TableHead>{t.credits.columns.description}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {credits.transactions.map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{formatDateTime(tx.createdAt)}</TableCell>
                      <TableCell className="text-xs">{tx.type.replace(/_/g, ' ')}</TableCell>
                      <TableCell
                        className={cn('text-right tabular-nums', tx.amount < 0 ? 'text-destructive' : 'text-emerald-600')}
                      >
                        {tx.amount > 0 ? '+' : ''}
                        {formatCredits(tx.amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCredits(tx.balanceAfter)}</TableCell>
                      <TableCell className="max-w-[28rem] truncate text-xs text-muted-foreground">
                        {tx.description ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, negative }: Readonly<{ label: string; value: string; negative?: boolean }>) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', negative && 'text-destructive')}>{value}</div>
    </div>
  );
}
