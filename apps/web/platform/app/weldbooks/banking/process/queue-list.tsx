/**
 * The queue on the left: the unprocessed lines of the account, paged, with the
 * server's real total, a search box, and a bulk checkbox on every line. A line
 * processed in this visit stays where it was, marked Done.
 */

import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { directionOf, type LineDirection } from './process-model';

export interface QueueListProps {
  lines: readonly BankLine[];
  totalCount: number;
  selectedId: string | null;
  doneIds: ReadonlySet<string>;
  bulkIds: ReadonlySet<string>;
  /** The direction of the lines already ticked: lines of the other direction cannot be added. */
  bulkDirection: LineDirection | null;
  canBulk: boolean;
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onToggleBulk: (line: BankLine) => void;
  onLoadMore: () => void;
  formatAmount: (amount: string) => string;
  formatDate: (date: string) => string;
}

export function QueueList({
  lines,
  totalCount,
  selectedId,
  doneIds,
  bulkIds,
  bulkDirection,
  canBulk,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  search,
  onSearchChange,
  onSelect,
  onToggleBulk,
  onLoadMore,
  formatAmount,
  formatDate,
}: Readonly<QueueListProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  const tl = t.accounting.bankReconcileList;
  const unknown = t.accounting.statusLabels.counterpartyUnknown;

  let body;
  if (isLoading) {
    body = (
      <div className="p-4">
        <PageLoader fullScreen={false} />
      </div>
    );
  } else if (isError) {
    body = <ErrorState message={tp.loadFailed} />;
  } else if (lines.length === 0) {
    body = <p className="p-4 text-sm text-muted-foreground">{search ? tl.noSearchResults : tp.allDone}</p>;
  } else {
    body = (
      <ul className="space-y-1.5" data-testid="process-queue">
        {lines.map((line) => {
          const selected = line.id === selectedId;
          const done = doneIds.has(line.id);
          const inflow = directionOf(line) === 'in';
          const name = line.counterpartyName || line.description || unknown;
          const blocked = bulkDirection !== null && bulkDirection !== directionOf(line) && !bulkIds.has(line.id);
          return (
            <li key={line.id} className="flex items-stretch gap-1.5">
              {canBulk && !done ? (
                <span className="flex items-center pl-1" title={blocked ? tp.differentDirection : undefined}>
                  <Checkbox
                    checked={bulkIds.has(line.id)}
                    disabled={blocked}
                    onCheckedChange={() => onToggleBulk(line)}
                    aria-label={tp.selectLine.replace('{name}', name)}
                  />
                </span>
              ) : null}
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                data-testid={`process-line-${line.id}`}
                onClick={() => onSelect(line.id)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn('truncate font-medium', done && 'text-muted-foreground')}>{name}</span>
                  <span className="truncate text-[13px] text-muted-foreground">
                    {formatDate(line.date)}
                    {line.description && line.counterpartyName ? ` · ${line.description}` : ''}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      done ? 'text-muted-foreground' : inflow && 'text-emerald-700 dark:text-emerald-400',
                    )}
                  >
                    {inflow ? '+' : ''}
                    {formatAmount(line.amount)}
                  </span>
                  {done ? (
                    <span className="inline-flex h-5 items-center rounded-full bg-emerald-100 px-2 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      {tp.done}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {hasNextPage ? (
          <li className="flex flex-col items-center gap-1 p-3">
            <p className="text-xs text-muted-foreground" role="status">
              {tl.shownOfTotal.replace('{shown}', String(lines.length)).replace('{total}', String(totalCount))}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadMore}
              disabled={isFetchingNextPage}
              data-testid="process-load-more"
            >
              {isFetchingNextPage ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              {tl.loadMore}
            </Button>
          </li>
        ) : null}
      </ul>
    );
  }

  return (
    <section aria-label={tp.queueLabel} className="flex min-w-0 flex-col gap-3">
      <SearchInput
        type="search"
        aria-label={tl.searchLabel}
        placeholder={tl.searchPlaceholder}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        autoComplete="off"
      />
      {body}
    </section>
  );
}
