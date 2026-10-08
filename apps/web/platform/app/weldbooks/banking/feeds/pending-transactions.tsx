import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useBankFeedPendingTransactions } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useFeedTexts } from './feed-texts';

/**
 * Transactions the bank has reported but not posted. They live next to the
 * books, never in them: reconciliation only sees a transaction once it posts.
 */
export function PendingTransactions({
  connectionId,
  bankAccountId,
}: Readonly<{ connectionId: string; bankAccountId?: string }>) {
  const { t } = useFeedTexts();
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const query = useBankFeedPendingTransactions(connectionId, bankAccountId);

  if (query.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <span>{t.pending.loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>
            {t.list.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const rows = query.data ?? [];
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.pending.empty}</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t.pending.description}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">{t.pending.columns.date}</TableHead>
            <TableHead>{t.pending.columns.description}</TableHead>
            <TableHead className="text-right">{t.pending.columns.amount}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const negative = Number(row.amount) < 0;
            return (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                <TableCell className="max-w-[360px] truncate">
                  {row.merchantName || row.description || (
                    <span className="text-muted-foreground">{t.pending.noDescription}</span>
                  )}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${negative ? 'text-foreground' : 'text-emerald-600 dark:text-emerald-400'}`}
                >
                  {formatMoney(row.amount, row.currency)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
