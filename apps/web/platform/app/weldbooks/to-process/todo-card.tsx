/**
 * One card of the To process page: a kind's count and amount, its first three
 * items and its one primary action; "Show all" expands the card into the full
 * list, paged by the server's cursor.
 */

import { useState } from 'react';
import { Banknote, FileSearch, MessageCircleQuestion } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Card, CardContent, CardFooter, CardHeader } from '@weldsuite/ui/components/card';
import { RecordChip, type RecordChipTone } from '@weldsuite/ui/components/record-chip';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { AskReceiptsDialog } from '@/components/accounting/questions/ask-receipts-dialog';
import { useBulkRemind } from '@/components/accounting/bulk-remind';
import { useObjectPanel } from '@/components/object-panel';
import { RecordLink } from '@/components/object-panel/record-link';
import { fetchCreditPayment } from '@/hooks/queries/use-weldbooks-processing-queries';
import {
  TODO_TOP_LIMIT,
  useInfiniteTodoItems,
  useTodoTopItems,
} from '@/hooks/queries/use-weldbooks-todo-queries';
import { isQuestionsAvailable } from '@/hooks/queries/use-weldbooks-questions-queries';
import { isRemindersAvailable, useReminderDueItems } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { TodoItem, TodoKind, TodoKindSummary, TodoSeverity } from '@/lib/api/domains/weldbooks';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
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

/** Picking items of a card (the lines to ask receipts for): which ones are picked, and how to toggle one. */
export interface TodoSelection {
  ids: ReadonlySet<string>;
  toggle: (id: string) => void;
}

/** One item: a chip that opens its record, the hint in words, the amount and the date. */
export function TodoItemRow({ item, selection }: Readonly<{ item: TodoItem; selection?: TodoSelection }>) {
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
      {selection ? (
        <Checkbox
          checked={selection.ids.has(item.objectId)}
          onCheckedChange={() => selection.toggle(item.objectId)}
          aria-label={copy.receiptsPick.replace('{name}', label)}
          data-testid={`todo-select-${item.objectId}`}
        />
      ) : null}
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

function ItemList({ items, selection }: Readonly<{ items: readonly TodoItem[]; selection?: TodoSelection }>) {
  return (
    <ul className="divide-y">
      {items.map((item) => (
        <TodoItemRow key={`${item.objectType}:${item.objectId}`} item={item} selection={selection} />
      ))}
    </ul>
  );
}

/** Every item of a card, a page at a time. */
function AllItems({
  all,
  title,
  selection,
}: Readonly<{ all: ReturnType<typeof useInfiniteTodoItems>; title: string; selection?: TodoSelection }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  if (all.isError) return <ErrorState message={copy.listFailed} onRetry={() => void all.refetch()} />;
  if (!all.data) return <InlineSpinner />;
  return (
    <>
      <ItemList items={all.data.items} selection={selection} />
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

/**
 * "Send N reminders" on the overdue card: the primary action where the member may send them and
 * some are due and manual (hint `reminder_due`); then the link to the list is the quieter one.
 * Its own component, so a card without reminders asks for no data.
 */
function SendRemindersButton({
  viewAction,
  children,
}: Readonly<{ viewAction: { label: string; href: string } | null; children: React.ReactNode }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  const canUpdate = useCan('invoices:update');
  const due = useReminderDueItems({ enabled: canUpdate });
  const dueItems = canUpdate ? (due.data ?? []) : [];
  const bulk = useBulkRemind((id) => dueItems.find((item) => item.objectId === id)?.subtitle ?? id);
  const send = dueItems.length > 0;
  return (
    <>
      {send ? (
        <Button
          size="sm"
          disabled={bulk.pending}
          onClick={() => bulk.start(dueItems.map((item) => item.objectId))}
          data-testid="todo-send-reminders"
        >
          {plural(dueItems.length, copy.sendReminders, getLocale())}
        </Button>
      ) : null}
      {viewAction ? (
        <Button asChild size="sm" variant={send ? 'outline' : 'default'}>
          {children}
        </Button>
      ) : null}
      {bulk.dialogs}
    </>
  );
}

/**
 * "Ask for receipts" on the Missing receipts card, for a member who books and may write in a chat: pick the
 * lines, then ask about all of them at once (`POST /api/accounting-questions/bulk`).
 */
function ReceiptsAskBar({
  selecting,
  count,
  onStart,
  onCancel,
  onAsk,
}: Readonly<{ selecting: boolean; count: number; onStart: () => void; onCancel: () => void; onAsk: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldbooksQuestions.receipts;
  if (!selecting) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={onStart} title={tr.selectHint} data-testid="todo-ask-receipts">
        <MessageCircleQuestion className="size-4" aria-hidden />
        {tr.select}
      </Button>
    );
  }
  return (
    <>
      <span className="text-sm font-medium" role="status" data-testid="todo-receipts-count">
        {plural(count, tr.selected, getLocale())}
      </span>
      <Button type="button" size="sm" disabled={count === 0} onClick={onAsk} data-testid="todo-receipts-ask">
        <MessageCircleQuestion className="size-4" aria-hidden />
        {tr.select}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        {tr.cancel}
      </Button>
    </>
  );
}

export function TodoCard({ kind, summary }: Readonly<{ kind: TodoKind; summary: TodoKindSummary }>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.todo;
  const { formatMoney } = useWeldbooksFormat();
  const [expanded, setExpanded] = useState(false);
  // The accountant asks for several receipts at once (edition feature `books-questions`).
  const canAsk = useCan('messages:create');
  const canBook = useCan('journal:create');
  const askReceipts = kind === 'missing_receipts' && isQuestionsAvailable() && canAsk && canBook;
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [askOpen, setAskOpen] = useState(false);
  const selection: TodoSelection | undefined = selecting
    ? {
        ids: new Set(picked),
        toggle: (id) => setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id])),
      }
    : undefined;
  // The overdue card sends the reminders that are due and not sent by themselves (edition feature `books-reminders`).
  const remindersOn = kind === 'invoices_overdue' && isRemindersAvailable();
  const top = useTodoTopItems(kind, TODO_TOP_LIMIT);
  const all = useInfiniteTodoItems(kind, { enabled: expanded });
  const action = todoKindAction(kind, summary.count, top.data ?? [], copy);
  const title = todoKindTitle(kind, copy);
  const kindSummary = todoKindSummary(kind, summary.count, copy);
  const headingId = `todo-${kind}`;
  const canExpand = summary.count > TODO_TOP_LIMIT;
  // What a picked line is called in the result of the bulk ask.
  const lineName = (id: string) => {
    const known = [...(all.data?.items ?? []), ...(top.data ?? [])].find((item) => item.objectId === id);
    return known?.title ?? known?.subtitle ?? t.accounting.statusLabels.counterpartyUnknown;
  };
  const startSelecting = () => {
    setSelecting(true);
    // Every line can be picked, not only the first three.
    setExpanded(true);
  };
  const stopSelecting = () => {
    setSelecting(false);
    setPicked([]);
  };

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
            <AllItems all={all} title={title} selection={selection} />
          ) : top.isError ? (
            <ErrorState message={copy.listFailed} onRetry={() => void top.refetch()} />
          ) : top.data ? (
            <ItemList items={top.data} selection={selection} />
          ) : (
            <InlineSpinner />
          )}
        </CardContent>
        {action || canExpand || askReceipts ? (
          <CardFooter className="flex flex-wrap items-center gap-2">
            {remindersOn ? (
              <SendRemindersButton viewAction={action}>
                {action ? <Link href={action.href}>{action.label}</Link> : null}
              </SendRemindersButton>
            ) : action ? (
              <Button asChild size="sm">
                <Link href={action.href}>{action.label}</Link>
              </Button>
            ) : null}
            {askReceipts ? (
              <ReceiptsAskBar
                selecting={selecting}
                count={picked.length}
                onStart={startSelecting}
                onCancel={stopSelecting}
                onAsk={() => setAskOpen(true)}
              />
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
      {askReceipts ? (
        <AskReceiptsDialog
          open={askOpen}
          onOpenChange={setAskOpen}
          lineIds={picked}
          lineName={lineName}
          onDone={stopSelecting}
        />
      ) : null}
    </article>
  );
}
