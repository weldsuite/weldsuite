/**
 * The actions of the processing view: accepting the suggestion, booking a
 * line to a category, a transfer or documents, marking it private or ignored,
 * undo, bulk booking and the keyboard. They work on the state in
 * `use-process-state.ts`.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMatchBankLineToDeposit, useMatchBankLineToPayment } from '@/hooks/queries/use-weldbooks-banking-queries';
import {
  invalidateAfterProcessing,
  useCategorizeBankLine,
  usePrivateBankLine,
  useTransferBankLine,
  useUndoBankLine,
} from '@/hooks/queries/use-weldbooks-processing-queries';
import { accountingApi, type Account } from '@/lib/api/domains/weldbooks';
import type { BankLine, MatchDocumentsResult, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import type { CategorizeInput } from '@/lib/api/domains/weldbooks-processing';
import type { ActionId } from './line-parts';
import {
  categoryText,
  documentsText,
  ledgerAccountName,
  messageOf,
  suggestionText,
  transferText,
  without,
  type DoneEntry,
  type DoneKind,
  type Mode,
  type ProcessingCopy,
} from './process-helpers';
import { directionOf, nextLineId, stepLineId, type LineDirection } from './process-model';
import { isDialogOpen, useProcessShortcuts } from './process-shortcuts';
import type { ProcessState } from './use-process-state';

type Mutate<TInput> = (input: TInput, options: { onSuccess: () => void; onError: (error: unknown) => void }) => void;

interface LineContext {
  state: ProcessState;
  copy: ProcessingCopy;
  selectedLine: BankLine | null;
  selectedDone: DoneEntry | null;
  canUpdate: boolean;
}

/** Whether an action may run on the selected line right now. */
function canActOn(ctx: LineContext): boolean {
  return Boolean(ctx.selectedLine) && !ctx.selectedDone && ctx.canUpdate;
}

/** Focus, select and finish: how the view moves from one line to the next. */
function useProcessNavigation(state: ProcessState, queue: BankLine[], doneIds: Set<string>) {
  const { detailRef, setSelectedId, setMode, setActionError, setSuggestionError, setDone, setLastDoneId, setBulk, setNotice } =
    state;

  const focusDetail = useCallback(() => {
    // The next shortcut key (Enter) must reach the page, not a button that has just gone.
    detailRef.current?.focus({ preventScroll: true });
  }, [detailRef]);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMode(null);
      setActionError(null);
      setSuggestionError(null);
      focusDetail();
    },
    [focusDetail, setSelectedId, setMode, setActionError, setSuggestionError],
  );

  /** A line is processed: mark it Done, open the next one that is not. */
  const finish = (line: BankLine, text: string, kind: DoneKind) => {
    const index = Math.max(0, queue.findIndex((candidate) => candidate.id === line.id));
    const nextDone = new Set([...doneIds, line.id]);
    setDone((current) => ({ ...current, [line.id]: { line, text, kind, index } }));
    setLastDoneId(line.id);
    setBulk((current) => without(current, line.id));
    setMode(null);
    setNotice(null);
    setActionError(null);
    setSuggestionError(null);
    setSelectedId(nextLineId(queue, nextDone, line.id));
    focusDetail();
  };

  return { focusDetail, select, finish };
}

type Finish = ReturnType<typeof useProcessNavigation>['finish'];

/** Accept the best suggestion with one button (Enter). */
function useSuggestionAction(ctx: LineContext, best: MatchSuggestion | null, finish: Finish) {
  const qc = useQueryClient();
  const { setSuggestionError } = ctx.state;
  const matchPayment = useMatchBankLineToPayment();
  const matchDeposit = useMatchBankLineToDeposit();
  const reconcile = useMutation({
    mutationFn: ({ lineId, data }: { lineId: string; data: Record<string, unknown> }) =>
      accountingApi.reconcileTransaction(lineId, data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
  const matching = reconcile.isPending || matchPayment.isPending || matchDeposit.isPending;

  const runSuggestion = (line: BankLine, s: MatchSuggestion, onSuccess: () => void, onError: (e: unknown) => void) => {
    if (s.type === 'payment') {
      matchPayment.mutate({ lineId: line.id, paymentId: s.id }, { onSuccess, onError });
    } else if (s.type === 'deposit') {
      matchDeposit.mutate({ lineId: line.id, depositId: s.id }, { onSuccess, onError });
    } else if (s.type === 'rule') {
      // The server applies the rule's account, tax rate and contact, and counts the match.
      reconcile.mutate({ lineId: line.id, data: { type: 'manual', ruleId: s.id } }, { onSuccess, onError });
    } else {
      reconcile.mutate({ lineId: line.id, data: { type: s.type, entityId: s.id } }, { onSuccess, onError });
    }
  };

  const accept = () => {
    if (!ctx.selectedLine || !best || !canActOn(ctx)) return;
    setSuggestionError(null);
    const line = ctx.selectedLine;
    const text = suggestionText(best, ctx.copy);
    const onSuccess = () => finish(line, text, 'suggestion');
    const onError = (error: unknown) => setSuggestionError(messageOf(error) || ctx.copy.result.failed);
    runSuggestion(line, best, onSuccess, onError);
  };

  return { accept, matching };
}

/** Book the line to a category, a transfer or the documents it paid. */
function useBookingActions(ctx: LineContext, finish: Finish, ledgerAccounts: Account[], bankAccounts: { id: string; name: string }[], formatAmount: (amount: string) => string) {
  const { setActionError } = ctx.state;
  const tr = ctx.copy.result;
  const categorize = useCategorizeBankLine();
  const transfer = useTransferBankLine();

  const submitCategory = (input: CategorizeInput) => {
    if (!ctx.selectedLine) return;
    const line = ctx.selectedLine;
    setActionError(null);
    categorize.mutate(
      { lineId: line.id, data: input },
      {
        onSuccess: () => finish(line, categoryText(input, tr, ledgerAccounts), 'category'),
        onError: (error) => setActionError(messageOf(error) || tr.failed),
      },
    );
  };

  const submitTransfer = (bankAccountId: string | undefined) => {
    if (!ctx.selectedLine) return;
    const line = ctx.selectedLine;
    setActionError(null);
    transfer.mutate(
      { lineId: line.id, bankAccountId },
      {
        onSuccess: (result) => finish(line, transferText(result, bankAccounts, tr), 'transfer'),
        onError: (error) => setActionError(messageOf(error) || tr.failed),
      },
    );
  };

  const documentsLinked = (result: MatchDocumentsResult) => {
    if (ctx.selectedLine) finish(ctx.selectedLine, documentsText(result, tr, formatAmount), 'documents');
  };

  return {
    submitCategory,
    submitTransfer,
    documentsLinked,
    categorizePending: categorize.isPending,
    transferPending: transfer.isPending,
  };
}

/** Mark the line private or ignore it: one click, no form. */
function useQuickActions(ctx: LineContext, finish: Finish) {
  const qc = useQueryClient();
  const { setActionError } = ctx.state;
  const tr = ctx.copy.result;
  const markPrivate = usePrivateBankLine();
  const exclude = useMutation({
    mutationFn: (lineId: string) => accountingApi.excludeTransaction(lineId),
    onSuccess: () => invalidateAfterProcessing(qc),
  });

  const run = (mutate: Mutate<string>, text: string, kind: DoneKind) => {
    if (!ctx.selectedLine || !canActOn(ctx)) return;
    const line = ctx.selectedLine;
    setActionError(null);
    mutate(line.id, {
      onSuccess: () => finish(line, text, kind),
      onError: (error) => setActionError(messageOf(error) || tr.failed),
    });
  };

  const runPrivate = () => run((id, options) => markPrivate.mutate(id, options), tr.private, 'private');
  const runIgnore = () => run((id, options) => exclude.mutate(id, options), tr.ignore, 'ignore');
  return { runPrivate, runIgnore };
}

/** Open a form, or run a one-click action, for a key or a button of the action grid. */
function useModeActions(ctx: LineContext, quick: { runPrivate: () => void; runIgnore: () => void }) {
  const { setActionError, setMode } = ctx.state;

  const openMode = (next: Mode) => {
    if (!canActOn(ctx)) return;
    setActionError(null);
    setMode(next);
  };

  const runAction = (action: ActionId) => {
    if (action === 'private') quick.runPrivate();
    else if (action === 'ignore') quick.runIgnore();
    else openMode(action);
  };

  return { openMode, runAction };
}

/** The one Undo of the success line. */
function useUndoAction(ctx: LineContext, focusDetail: () => void) {
  const { setActionError, setDone, setLastDoneId, setSelectedId, setNotice } = ctx.state;
  const tr = ctx.copy.result;
  const undo = useUndoBankLine();

  const undoEntry = (entry: DoneEntry) => {
    setActionError(null);
    undo.mutate(entry.line.id, {
      onSuccess: () => {
        setDone((current) => without(current, entry.line.id));
        setLastDoneId((current) => (current === entry.line.id ? null : current));
        setSelectedId(entry.line.id);
        setNotice(tr.undone);
        focusDetail();
      },
      onError: (error) => {
        setActionError(messageOf(error) || tr.undoFailed);
        toast.error(tr.undoFailed, { description: messageOf(error) || undefined });
      },
    });
  };

  return { undoEntry, undoPending: undo.isPending };
}

/** Select several lines and book them to one category. */
function useBulkActions(
  state: ProcessState,
  queue: BankLine[],
  doneIds: Set<string>,
  copy: ProcessingCopy,
  ledgerAccounts: Account[],
) {
  const { bulk, setBulk, setDone, selectedId, setSelectedId } = state;
  const bulkLines = Object.values(bulk);
  const bulkDirection: LineDirection | null = bulkLines[0] ? directionOf(bulkLines[0]) : null;
  const bulkIds = useMemo(() => new Set(Object.keys(bulk)), [bulk]);

  const toggleBulk = (line: BankLine) =>
    setBulk((current) => (current[line.id] ? without(current, line.id) : { ...current, [line.id]: line }));

  const bulkBooked = (ids: string[], accountId: string) => {
    const text = copy.result.category.replace('{category}', ledgerAccountName(ledgerAccounts, accountId));
    const nextDone = new Set([...doneIds, ...ids]);
    setDone((current) => {
      const next = { ...current };
      for (const id of ids) {
        const line = bulk[id];
        if (line) next[id] = { line, text, kind: 'category', index: Math.max(0, queue.findIndex((q) => q.id === id)) };
      }
      return next;
    });
    setBulk({});
    setSelectedId(nextLineId(queue, nextDone, selectedId));
  };

  return { bulkLines, bulkIds, bulkDirection, toggleBulk, bulkBooked };
}

/** Escape closes the open form, also from inside its fields (the shortcuts leave typing targets alone). */
function useEscapeToCloseMode(state: ProcessState) {
  const { mode, setMode, detailRef } = state;
  // A list that is open inside the form (a select) takes the key first and marks it handled.
  useEffect(() => {
    if (!mode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isDialogOpen()) return;
      if (event.target instanceof Node && detailRef.current?.contains(event.target)) setMode(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mode, setMode, detailRef]);
}

interface KeyboardParams {
  enabled: boolean;
  state: ProcessState;
  queue: BankLine[];
  canAct: boolean;
  canUpdate: boolean;
  accept: (() => void) | undefined;
  openMode: (mode: Mode) => void;
  quick: { runPrivate: () => void; runIgnore: () => void };
  bannerEntry: DoneEntry | null;
  undoPending: boolean;
  undoEntry: (entry: DoneEntry) => void;
}

/** A handler that only exists while its condition holds (a shortcut without a handler is left to the browser). */
function when(condition: boolean, handler: () => void): (() => void) | undefined {
  return condition ? handler : undefined;
}

function useProcessKeyboard(p: KeyboardParams) {
  const { setSelectedId, setHelpOpen, setMode, mode } = p.state;
  const { canAct, bannerEntry } = p;
  const undoEntry = bannerEntry ? () => p.undoEntry(bannerEntry) : undefined;
  useProcessShortcuts(p.enabled, {
    next: () => setSelectedId((current) => stepLineId(p.queue, current, 1)),
    previous: () => setSelectedId((current) => stepLineId(p.queue, current, -1)),
    accept: p.accept,
    category: when(canAct, () => p.openMode('category')),
    receipt: when(canAct, () => p.openMode('receipt')),
    transfer: when(canAct, () => p.openMode('transfer')),
    private: when(canAct, p.quick.runPrivate),
    ignore: when(canAct, p.quick.runIgnore),
    undo: p.canUpdate && !p.undoPending ? undoEntry : undefined,
    help: () => setHelpOpen(true),
    close: when(mode !== null, () => setMode(null)),
  });
  useEscapeToCloseMode(p.state);
}

interface ProcessActionsParams {
  state: ProcessState;
  copy: ProcessingCopy;
  queue: BankLine[];
  doneIds: Set<string>;
  selectedLine: BankLine | null;
  selectedDone: DoneEntry | null;
  bannerEntry: DoneEntry | null;
  best: MatchSuggestion | null;
  canUpdate: boolean;
  keyboardEnabled: boolean;
  ledgerAccounts: Account[];
  bankAccounts: { id: string; name: string }[];
  formatAmount: (amount: string) => string;
}

export function useProcessActions(p: ProcessActionsParams) {
  const { state, copy, queue, doneIds, selectedLine, selectedDone, canUpdate } = p;
  const ctx: LineContext = { state, copy, selectedLine, selectedDone, canUpdate };
  const { focusDetail, select, finish } = useProcessNavigation(state, queue, doneIds);
  const { accept, matching } = useSuggestionAction(ctx, p.best, finish);
  const booking = useBookingActions(ctx, finish, p.ledgerAccounts, p.bankAccounts, p.formatAmount);
  const quick = useQuickActions(ctx, finish);
  const { openMode, runAction } = useModeActions(ctx, quick);
  const { undoEntry, undoPending } = useUndoAction(ctx, focusDetail);
  const bulk = useBulkActions(state, queue, doneIds, copy, p.ledgerAccounts);
  const canAct = canActOn(ctx);
  useProcessKeyboard({
    enabled: p.keyboardEnabled,
    state,
    queue,
    canAct,
    canUpdate,
    accept: canAct && p.best && !matching ? accept : undefined,
    openMode,
    quick,
    bannerEntry: p.bannerEntry,
    undoPending,
    undoEntry,
  });
  return { select, finish, accept, matching, openMode, runAction, undoEntry, undoPending, ...booking, ...bulk };
}
