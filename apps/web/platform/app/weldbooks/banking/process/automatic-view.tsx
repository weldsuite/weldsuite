/**
 * "Booked automatically": the lines a rule or auto-link booked without a
 * person, each with the reason (from the line's connections) and an Undo.
 *
 * For an accountant (edition feature `books-questions`, `journal:update`) each
 * line also carries the review mark of its booking: a "Not reviewed" /
 * "Reviewed" filter, "Mark reviewed" per line and for the lines picked.
 */

import { useId, useState } from 'react';
import { Undo2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ReviewChip, ReviewMarkButton, useCanReview } from '@/components/accounting/questions/review-mark';
import { RecordLink } from '@/components/object-panel/record-link';
import { useBankLineLinks, useInfiniteBankLines } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useReviewBankLines } from '@/hooks/queries/use-weldbooks-questions-queries';
import { useUndoBankLine } from '@/hooks/queries/use-weldbooks-processing-queries';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { automaticReasonLabel } from './process-model';

type ReviewFilter = 'notReviewed' | 'reviewed';

interface AutomaticRowProps {
  line: BankLine;
  currency: string | null;
  canUndo: boolean;
  /** The review controls: the chip, the per-line button and the checkbox. */
  review: { selected: boolean; onToggle: () => void } | null;
}

function AutomaticRow({ line, currency, canUndo, review }: Readonly<AutomaticRowProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksConnected.automatic;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const links = useBankLineLinks(line.id).data;
  const undo = useUndoBankLine();
  const name = line.counterpartyName || line.description || t.accounting.statusLabels.counterpartyUnknown;
  const inflow = Number(line.amount) >= 0;
  const entryId = links?.journalEntry?.id ?? null;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3" data-testid={`automatic-line-${line.id}`}>
      {review ? (
        <Checkbox
          checked={review.selected}
          onCheckedChange={review.onToggle}
          aria-label={t.weldbooksQuestions.review.selectLine.replace('{name}', name)}
          data-testid={`automatic-select-${line.id}`}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <RecordLink type="bank_transaction" id={line.id} label={name} secondary={formatDate(line.date)} />
          <span
            className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-xs font-medium"
            data-testid="automatic-reason"
          >
            {automaticReasonLabel(links?.reason, links?.rule ?? null, ta.reasons)}
          </span>
          {review ? <ReviewChip reviewedAt={line.reviewedAt} /> : null}
        </span>
        {line.description ? <span className="truncate text-[13px] text-muted-foreground">{line.description}</span> : null}
      </div>
      <span className={inflow ? 'font-semibold tabular-nums text-emerald-700 dark:text-emerald-400' : 'font-semibold tabular-nums'}>
        {inflow ? '+' : ''}
        {formatMoney(line.amount, currency)}
      </span>
      {review && entryId ? <ReviewMarkButton journalEntryId={entryId} reviewed={!!line.reviewedAt} /> : null}
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

/** "Not reviewed" / "Reviewed": two choices, so visible radio buttons rather than a select. */
function ReviewFilterChoice({
  value,
  onChange,
}: Readonly<{ value: ReviewFilter; onChange: (next: ReviewFilter) => void }>) {
  const { t } = useI18n();
  const tr = t.weldbooksQuestions.review;
  const name = useId();
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="review-filter">
      <legend className="sr-only">{tr.filterLabel}</legend>
      {(['notReviewed', 'reviewed'] as const).map((choice) => (
        <label key={choice} className="flex cursor-pointer items-center gap-1.5 text-sm">
          <input
            type="radio"
            name={name}
            className="accent-primary"
            checked={value === choice}
            onChange={() => onChange(choice)}
            data-testid={`review-filter-${choice}`}
          />
          {tr[choice]}
        </label>
      ))}
    </fieldset>
  );
}

/** The bar over the lines picked: how many, and "Mark reviewed" for all of them. */
function ReviewBulkBar({
  lines,
  allSelected,
  onSelectAll,
  onClear,
}: Readonly<{ lines: readonly string[]; allSelected: boolean; onSelectAll: () => void; onClear: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldbooksQuestions.review;
  const mark = useReviewBankLines();

  const run = () =>
    mark.mutate([...lines], {
      onSuccess: (result) => {
        const done = plural(result.reviewed.length, tr.bulkDone, getLocale());
        const skipped = result.skipped.length > 0 ? ` ${plural(result.skipped.length, tr.bulkSkipped, getLocale())}` : '';
        toast.success(`${done}${skipped}`);
        onClear();
      },
      onError: (error) => toast.error(tr.bulkFailed, { description: error instanceof Error ? error.message : undefined }),
    });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="review-bulk-bar">
      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox checked={allSelected} onCheckedChange={() => (allSelected ? onClear() : onSelectAll())} />
        <span className="sr-only">{tr.selectAll}</span>
      </label>
      <span className="flex-1 font-medium" role="status">
        {lines.length > 0 ? plural(lines.length, tr.bulkSelected, getLocale()) : tr.selectAll}
      </span>
      <Button type="button" size="sm" disabled={lines.length === 0 || mark.isPending} onClick={run} data-testid="review-bulk-mark">
        {mark.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
        {tr.bulkAction}
      </Button>
      {lines.length > 0 ? (
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          {tr.clearSelection}
        </Button>
      ) : null}
    </div>
  );
}

type LinesQuery = ReturnType<typeof useInfiniteBankLines>;

interface AutomaticBodyProps {
  query: LinesQuery;
  canReview: boolean;
  filter: ReviewFilter;
  currency: string | null;
  picked: string[];
  setPicked: (ids: string[]) => void;
}

/** The lines (with the review bar and Load more) once there are some to show. */
function AutomaticLines({ query, canReview, filter, currency, picked, setPicked }: Readonly<AutomaticBodyProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksConnected.automatic;
  const { can } = usePermissions();
  const lines = query.data?.lines ?? [];
  const shownIds = lines.map((line) => line.id);
  // What was picked on a list that has since changed is not marked by mistake.
  const pickedShown = picked.filter((id) => shownIds.includes(id));
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  return (
    <>
      {canReview && filter === 'notReviewed' ? (
        <ReviewBulkBar
          lines={pickedShown}
          allSelected={pickedShown.length === shownIds.length}
          onSelectAll={() => setPicked(shownIds)}
          onClear={() => setPicked([])}
        />
      ) : null}
      <ul className="space-y-2" data-testid="automatic-list">
        {lines.map((line) => (
          <AutomaticRow
            key={line.id}
            line={line}
            currency={currency}
            canUndo={can('banking:update')}
            review={canReview ? { selected: pickedShown.includes(line.id), onToggle: () => toggle(line.id) } : null}
          />
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

/** The title of the empty state: what is left to review, or nothing at all. */
function emptyTitle(canReview: boolean, filter: ReviewFilter, ta: { empty: string }, tr: { emptyReviewed: string; emptyNotReviewed: string }) {
  if (!canReview) return ta.empty;
  return filter === 'reviewed' ? tr.emptyReviewed : tr.emptyNotReviewed;
}

function AutomaticBody(props: Readonly<AutomaticBodyProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksConnected.automatic;
  const tr = t.weldbooksQuestions.review;
  const { query, canReview, filter } = props;
  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError) return <ErrorState message={ta.loadFailed} onRetry={() => void query.refetch()} />;
  if ((query.data?.lines ?? []).length === 0) return <EmptyState title={emptyTitle(canReview, filter, ta, tr)} />;
  return <AutomaticLines {...props} />;
}

export function AutomaticView({ bankAccountId, currency }: Readonly<{ bankAccountId: string; currency: string | null }>) {
  const { t } = useI18n();
  const ta = t.weldbooksConnected.automatic;
  const canReview = useCanReview();
  const [filter, setFilter] = useState<ReviewFilter>('notReviewed');
  const [picked, setPicked] = useState<string[]>([]);
  const query = useInfiniteBankLines({
    bankAccountId,
    processedAutomatically: true,
    // The accountant works through what is not reviewed yet; everyone else sees every line.
    ...(canReview ? { reviewed: filter === 'reviewed' } : {}),
  });

  return (
    <section className="space-y-4" aria-label={ta.title}>
      <p className="text-sm text-muted-foreground">{ta.description}</p>
      {canReview ? (
        <ReviewFilterChoice
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setPicked([]);
          }}
        />
      ) : null}
      <AutomaticBody
        query={query}
        canReview={canReview}
        filter={filter}
        currency={currency}
        picked={picked}
        setPicked={setPicked}
      />
    </section>
  );
}
