import { RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useLiabilityCheck } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { LiabilityCheck, TaxReturnDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DocumentLink } from '../../shared/document-link';
import { Notice } from '../../shared/notice';
import { ErrorState, RowsSkeleton } from '../../shared/query-states';
import { fill, toCents } from '../../shared/text';

/** What the liability check found: the ledger balance against what the tax ledger says is owed. */
export function LiabilityCheckResult({ check }: Readonly<{ check: LiabilityCheck }>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.salesTax.center.returnPage.liability;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tied = toCents(check.difference) === 0;

  const figures: Array<{ label: string; value: number; strong?: boolean; testId: string }> = [
    { label: tl.collected, value: check.collectedTax, testId: 'liability-collected' },
    { label: tl.paid, value: check.paidTax, testId: 'liability-paid' },
    { label: tl.filedUnpaid, value: check.filedUnpaidTax, testId: 'liability-filed-unpaid' },
    { label: tl.unfiled, value: check.unfiledTax, testId: 'liability-unfiled' },
    { label: tl.expected, value: check.expectedBalance, strong: true, testId: 'liability-expected' },
    { label: tl.glBalance, value: check.glBalance, strong: true, testId: 'liability-gl-balance' },
  ];

  return (
    <>
      {tied ? (
        <Notice tone="success" data-testid="liability-tied">
          <p>{tl.tied}</p>
        </Notice>
      ) : (
        <Notice tone="warning" data-testid="liability-differs">
          <p>{fill(tl.differs, { amount: formatMoney(Math.abs(check.difference)) })}</p>
        </Notice>
      )}
      {check.sharedAccount ? (
        <Notice tone="info">
          <p>{tl.sharedAccount}</p>
        </Notice>
      ) : null}

      <dl className="grid gap-3 rounded-md border p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.testId}>
            <dt className="text-xs text-muted-foreground">{figure.label}</dt>
            <dd className={cn('tabular-nums', figure.strong && 'font-semibold')} data-testid={figure.testId}>
              {formatMoney(figure.value)}
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-muted-foreground">{tl.difference}</dt>
          <dd className={cn('font-semibold tabular-nums', !tied && 'text-destructive')} data-testid="liability-difference">
            {formatMoney(check.difference)}
          </dd>
        </div>
      </dl>

      {check.accounts.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {tl.accounts}: {check.accounts.map((account) => `${account.code} ${account.name}`).join(', ')}
          {' · '}
          {fill(tl.asOf, { date: formatDate(check.asOf) })}
        </p>
      ) : null}

      {check.items.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{tl.itemsTitle}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tl.entry}</TableHead>
                <TableHead>{tl.date}</TableHead>
                <TableHead>{tl.descriptionColumn}</TableHead>
                <TableHead className="text-right">{tl.inLedger}</TableHead>
                <TableHead className="text-right">{tl.expectedColumn}</TableHead>
                <TableHead className="text-right">{tl.differenceColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {check.items.map((item) => (
                <TableRow key={item.journalEntryId} data-testid="liability-item">
                  <TableCell>
                    <DocumentLink type="journal_entry" id={item.journalEntryId} number={item.entryNumber ?? item.journalEntryId} />
                  </TableCell>
                  <TableCell>{formatDate(item.date)}</TableCell>
                  <TableCell className="max-w-[20rem] truncate">{item.description ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(item.glAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(item.expectedAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">{formatMoney(item.difference)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : tied ? null : (
        <p className="text-sm text-muted-foreground">{tl.noItems}</p>
      )}
    </>
  );
}

interface LiabilityCheckCardProps {
  ret: TaxReturnDetail;
  /** Run the check (the tab is open). */
  enabled: boolean;
}

/** The liability check: the agency's payable account against what is owed, with the entries that explain a difference. */
export function LiabilityCheckCard({ ret, enabled }: Readonly<LiabilityCheckCardProps>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.salesTax.center.returnPage.liability;
  const open = ret.status === 'open';
  const query = useLiabilityCheck(ret.id, { enabled: enabled && !open });

  return (
    <Card data-testid="liability-check-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-base">{tl.title}</CardTitle>
          <p className="text-xs text-muted-foreground">{tl.description}</p>
        </div>
        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={query.isFetching ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} aria-hidden="true" />
            {t.weldbooksUs.salesTax.center.common.refresh}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {open ? (
          <p className="text-sm text-muted-foreground">{tl.notAvailable}</p>
        ) : query.isLoading ? (
          <RowsSkeleton rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data ? (
          <LiabilityCheckResult check={query.data} />
        ) : null}
      </CardContent>
    </Card>
  );
}
