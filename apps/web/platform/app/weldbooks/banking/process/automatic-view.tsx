/**
 * "Booked automatically": the lines a rule or auto-link booked without a
 * person, each with the reason (from the line's connections) and an Undo.
 */

import { Undo2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { RecordLink } from '@/components/object-panel/record-link';
import { useBankLineLinks, useInfiniteBankLines } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useUndoBankLine } from '@/hooks/queries/use-weldbooks-processing-queries';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { automaticReasonLabel } from './process-model';

function AutomaticRow({ line, currency, canUndo }: Readonly<{ line: BankLine; currency: string | null; canUndo: boolean }>) {
  const { t } = useI18n();
  const ta = t.weldbooksConnected.automatic;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const links = useBankLineLinks(line.id).data;
  const undo = useUndoBankLine();
  const name = line.counterpartyName || line.description || t.accounting.statusLabels.counterpartyUnknown;
  const inflow = Number(line.amount) >= 0;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3" data-testid={`automatic-line-${line.id}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <RecordLink type="bank_transaction" id={line.id} label={name} secondary={formatDate(line.date)} />
          <span
            className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-xs font-medium"
            data-testid="automatic-reason"
          >
            {automaticReasonLabel(links?.reason, links?.rule ?? null, ta.reasons)}
          </span>
        </span>
        {line.description ? <span className="truncate text-[13px] text-muted-foreground">{line.description}</span> : null}
      </div>
      <span className={inflow ? 'font-semibold tabular-nums text-emerald-700 dark:text-emerald-400' : 'font-semibold tabular-nums'}>
        {inflow ? '+' : ''}
        {formatMoney(line.amount, currency)}
      </span>
      {canUndo ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={undo.isPending}
          onClick={() =>
            undo.mutate(line.id, {
              onSuccess: () => toast.success(ta.undone),
              onError: (error) => toast.error(ta.undoFailed, { description: error instanceof Error ? error.message : undefined }),
            })
          }
        >
          {undo.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" />}
          {ta.undo}
        </Button>
      ) : null}
    </li>
  );
}

export function AutomaticView({ bankAccountId, currency }: Readonly<{ bankAccountId: string; currency: string | null }>) {
  const { t } = useI18n();
  const ta = t.weldbooksConnected.automatic;
  const { can } = usePermissions();
  const query = useInfiniteBankLines({ bankAccountId, processedAutomatically: true });
  const lines = query.data?.lines ?? [];

  let body;
  if (query.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (query.isError) {
    body = <ErrorState message={ta.loadFailed} onRetry={() => void query.refetch()} />;
  } else if (lines.length === 0) {
    body = <EmptyState title={ta.empty} />;
  } else {
    body = (
      <>
        <ul className="space-y-2" data-testid="automatic-list">
          {lines.map((line) => (
            <AutomaticRow key={line.id} line={line} currency={currency} canUndo={can('banking:update')} />
          ))}
        </ul>
        {query.hasNextPage ? (
          <div className="flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              {ta.loadMore}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section className="space-y-4" aria-label={ta.title}>
      <p className="text-sm text-muted-foreground">{ta.description}</p>
      {body}
    </section>
  );
}
