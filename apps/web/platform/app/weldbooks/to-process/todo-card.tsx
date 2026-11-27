/**
 * One card of the To process page: a kind's count and amount, its first three
 * items and its one primary action; "Show all" expands the card into the full
 * list, paged by the server's cursor.
 */

import { useState } from 'react';
import { Banknote, FileSearch } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardFooter, CardHeader } from '@weldsuite/ui/components/card';
import { RecordChip, type RecordChipTone } from '@weldsuite/ui/components/record-chip';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useObjectPanel } from '@/components/object-panel';
import { RecordLink } from '@/components/object-panel/record-link';
import { fetchCreditPayment } from '@/hooks/queries/use-weldbooks-processing-queries';
import {
  TODO_TOP_LIMIT,
  useInfiniteTodoItems,
  useTodoTopItems,
} from '@/hooks/queries/use-weldbooks-todo-queries';
import type { TodoItem, TodoKind, TodoKindSummary, TodoSeverity } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { toPublicPath } from '@/lib/workspace-url-rewrite';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { cn } from '@/lib/utils';
import { todoHintLabel, todoItemTarget, todoKindAction, todoKindSummary, todoKindTitle } from './todo-targets';

const SEVERITY_TONE: Record<TodoSeverity, RecordChipTone> = {
  info: 'info',
  warning: 'warning',
  danger: 'danger',
};

const HINT_CLASS: Record<TodoSeverity, string> = {
  info: 'text-muted-foreground',
  warning: 'text-amber-700 dark:text-amber-400',
  danger: 'text-destructive',
};

/** An unapplied-credit item: a chip that opens the payment's contact on its Credit tab. */
function CreditItemChip({
  paymentId,
  label,
  secondary,
  tone,
  statusLabel,
}: Readonly<{ paymentId: string; label: string; secondary?: string; tone: RecordChipTone; statusLabel: string }>) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { open } = useObjectPanel();
  return (
    <RecordChip
      label={label}
      secondary={secondary ?? t.weldbooksConnected.credit.todoLink}
      icon={Banknote}
      tone={tone}
      statusLabel={statusLabel}
      onOpen={() => {
        void fetchCreditPayment(qc, paymentId).then((payment) => {
          if (payment?.contactId) open({ type: 'weldbooks_contact', id: payment.contactId, initialTab: 'credit', stack: true });
        });
      }}
    />
  );
}

/** One item: a chip that opens its record, the hint in words, the amount and the date. */
export function TodoItemRow({ item }: Readonly<{ item: TodoItem }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  const router = useRouter();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const target = todoItemTarget(item);
  const label = item.title ?? item.subtitle ?? '—';
  const secondary = item.title && item.subtitle ? item.subtitle : undefined;
  const tone = SEVERITY_TONE[item.severity] ?? 'neutral';
  const statusLabel = copy.severity[item.severity];
  const hint = todoHintLabel(item.hint, copy);
  const when = item.dueDate
    ? copy.dueOn.replace('{date}', formatDate(item.dueDate))
    : item.date
      ? formatDate(item.date)
      : null;

  let chip;
  if (target.kind === 'panel') {
    chip = <RecordLink type={target.type} id={target.id} label={label} secondary={secondary} tone={tone} statusLabel={statusLabel} />;
  } else if (target.kind === 'page') {
    chip = (
      <RecordChip
        label={label}
        secondary={secondary}
        icon={FileSearch}
        tone={tone}
        statusLabel={statusLabel}
        href={toPublicPath(target.href)}
        onOpen={() => router.push(target.href)}
      />
    );
  } else if (target.kind === 'credit') {
    chip = (
      <CreditItemChip
        paymentId={target.paymentId}
        label={label}
        secondary={secondary}
        tone={tone}
        statusLabel={statusLabel}
      />
    );
  } else {
    // Nothing to open: the item is shown, without a link.
    chip = (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px]">
        <span className="truncate font-medium">{label}</span>
        {secondary ? <span className="truncate text-muted-foreground">{secondary}</span> : null}
        <span className="sr-only">{statusLabel}</span>
      </span>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" data-testid="todo-item">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <div className="flex min-w-0">{chip}</div>
        {hint ? <p className={cn('truncate text-xs', HINT_CLASS[item.severity])}>{hint}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        {item.amount ? <span className="text-sm font-medium tabular-nums">{formatMoney(item.amount, item.currency)}</span> : null}
        {when ? <span className="text-xs text-muted-foreground tabular-nums">{when}</span> : null}
      </div>
    </li>
  );
}

function ItemList({ items }: Readonly<{ items: readonly TodoItem[] }>) {
  return (
    <ul className="divide-y">
      {items.map((item) => (
        <TodoItemRow key={`${item.objectType}:${item.objectId}`} item={item} />
      ))}
    </ul>
  );
}

/** Every item of a card, a page at a time. */
function AllItems({ kind, title }: Readonly<{ kind: TodoKind; title: string }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  const all = useInfiniteTodoItems(kind);
  if (all.isError) return <ErrorState message={copy.listFailed} onRetry={() => void all.refetch()} />;
  if (!all.data) return <InlineSpinner />;
  return (
    <>
      <ItemList items={all.data.items} />
      {all.hasNextPage ? (
        <div className="pt-2">
          <Button variant="ghost" size="sm" disabled={all.isFetchingNextPage} onClick={() => void all.fetchNextPage()}>
            {all.isFetchingNextPage ? copy.loadingMore : copy.loadMore}
            <span className="sr-only"> {title}</span>
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function TodoCard({ kind, summary }: Readonly<{ kind: TodoKind; summary: TodoKindSummary }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  const { formatMoney } = useWeldbooksFormat();
  const [expanded, setExpanded] = useState(false);
  const top = useTodoTopItems(kind, TODO_TOP_LIMIT);
  const action = todoKindAction(kind, summary.count, top.data ?? [], copy);
  const title = todoKindTitle(kind, copy);
  const kindSummary = todoKindSummary(kind, summary.count, copy);
  const headingId = `todo-${kind}`;
  const canExpand = summary.count > TODO_TOP_LIMIT;

  return (
    <article aria-labelledby={headingId} className="@container/todo min-w-0" data-testid={`todo-card-${kind}`} data-kind={kind}>
      <Card className="h-full gap-4 py-5">
        <CardHeader className="gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id={headingId} className="min-w-0 truncate text-base font-semibold">
              {title}
            </h2>
            <span className="shrink-0 text-2xl font-semibold tabular-nums" data-testid="todo-count">
              {summary.count}
            </span>
          </div>
          {kindSummary ? (
            <p className="text-sm text-muted-foreground" data-testid="todo-kind-summary">
              {kindSummary}
            </p>
          ) : null}
          {summary.amount ? (
            <p className="text-sm text-muted-foreground tabular-nums">{formatMoney(summary.amount, summary.currency)}</p>
          ) : null}
          {summary.mixedCurrency && summary.currency ? (
            <p className="text-xs text-muted-foreground" data-testid="todo-mixed-currency">
              {copy.mixedCurrency.replace('{currency}', summary.currency)}
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {expanded ? (
            <AllItems kind={kind} title={title} />
          ) : top.isError ? (
            <ErrorState message={copy.listFailed} onRetry={() => void top.refetch()} />
          ) : top.data ? (
            <ItemList items={top.data} />
          ) : (
            <InlineSpinner />
          )}
        </CardContent>
        {action || canExpand ? (
          <CardFooter className="flex flex-wrap items-center gap-2">
            {action ? (
              <Button asChild size="sm">
                <Link href={action.href}>{action.label}</Link>
              </Button>
            ) : null}
            {canExpand ? (
              <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
                {expanded ? copy.showFewer : copy.showAll.replace('{count}', String(summary.count))}
                {/* Every card has this button: the kind tells them apart. */}
                <span className="sr-only"> {title}</span>
              </Button>
            ) : null}
          </CardFooter>
        ) : null}
      </Card>
    </article>
  );
}
