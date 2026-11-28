/**
 * The processing view (phase 2): Bank → Transactions → To process. The queue
 * of unprocessed lines is on the left, the selected line on the right with its
 * best suggestion as one button (Enter), the "Or" actions with shortcut keys
 * and the Connections strip. After every action the line is marked Done and
 * the next one opens; the success line carries the one Undo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { KeyboardHelp } from '@weldsuite/ui/components/keyboard-help';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Label } from '@weldsuite/ui/components/label';
import { ReconciliationRuleFormDialog } from '@/components/accounting/reconciliation-rule-form-dialog';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { useAccountingAccounts, useAccountingTaxRates } from '@/hooks/queries/use-accounting-queries';
import {
  useBankAccounts,
  useBankLine,
  useBankLineSuggestions,
  useInfiniteBankLines,
  useMatchBankLineToDeposit,
  useMatchBankLineToPayment,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import {
  invalidateAfterProcessing,
  useCategorizeBankLine,
  usePrivateBankLine,
  useTransferBankLine,
  useUndoBankLine,
} from '@/hooks/queries/use-weldbooks-processing-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { accountingApi, type Account } from '@/lib/api/domains/weldbooks';
import type { BankLine, MatchDocumentsResult, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import type { CategorizeInput, RuleFormPrefill } from '@/lib/api/domains/weldbooks-processing';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { MatchDocumentsPanel } from '../components/match-documents-panel';
import { maskedAccountNumber } from '../components/routing-number';
import { AutomaticView } from './automatic-view';
import { BulkCategorizeDialog } from './bulk-categorize-dialog';
import { CategoryForm } from './category-form';
import { ConnectionsStrip } from './connections-strip';
import { ActionGrid, HintRow, LineHeader, ResultBanner, type ActionId } from './line-parts';
import {
  bestSuggestion,
  directionOf,
  mergeQueue,
  nextLineId,
  stepLineId,
  type LineDirection,
  type RetainedLine,
} from './process-model';
import { isDialogOpen, useProcessShortcuts } from './process-shortcuts';
import { QueueList } from './queue-list';
import { ReceiptForm } from './receipt-form';
import { RuleOffer } from './rule-offer';
import { SuggestionCard, suggestionTarget } from './suggestion-card';
import { TransferForm } from './transfer-form';
import { isPaymentProviderAccount } from '@/lib/weldbooks/online-payments';

type Mode = 'category' | 'receipt' | 'transfer' | 'several';
type DoneKind = 'suggestion' | 'category' | 'transfer' | 'private' | 'ignore' | 'documents';

/** A line processed in this visit: kept in the queue marked Done, with the line of text its success banner shows. */
interface DoneEntry {
  line: BankLine;
  text: string;
  kind: DoneKind;
  /** Where the line sat in the queue, so it stays there. */
  index: number;
}

export interface ProcessSearch {
  accountId?: string;
  lineId?: string;
  action?: string;
  view?: string;
}

const MODES: readonly Mode[] = ['category', 'receipt', 'transfer', 'several'];

/** A copy of the record without one key. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
}

export function ProcessView() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ProcessSearch;
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  const tr = tp.result;
  const { can } = usePermissions();
  const canUpdate = can('banking:update');
  const { formatMoney, formatDate, currency: entityCurrency } = useWeldbooksFormat();
  const qc = useQueryClient();
  useObjectPanelUrlSync('/weldbooks/banking/process');

  // ── Account and queue ────────────────────────────────────────────────────
  const { data: bankAccountsData, isLoading: accountsLoading } = useBankAccounts();
  const bankAccounts = useMemo(() => bankAccountsData?.data ?? [], [bankAccountsData]);
  const [accountChoice, setAccountChoice] = useState(search.accountId ?? '');
  const selectedAccountId = accountChoice || (bankAccounts.find((a) => a.isDefault)?.id ?? bankAccounts[0]?.id ?? '');
  const selectedAccount = bankAccounts.find((account) => account.id === selectedAccountId);
  const currency = selectedAccount?.currency || entityCurrency;
  const [view, setView] = useState<'toProcess' | 'automatic'>(search.view === 'automatic' ? 'automatic' : 'toProcess');

  const [lineSearch, setLineSearch] = useState('');
  const debouncedSearch = useDebounce(lineSearch.trim(), 300);
  const linesQuery = useInfiniteBankLines(
    selectedAccountId
      ? { bankAccountId: selectedAccountId, status: 'unreconciled', search: debouncedSearch || undefined }
      : undefined,
  );
  const serverLines = useMemo(() => linesQuery.data?.lines ?? [], [linesQuery.data]);
  const totalCount = linesQuery.data?.totalCount ?? 0;

  const { data: accountsData } = useAccountingAccounts();
  const ledgerAccounts = useMemo(() => (accountsData?.data ?? []) as Account[], [accountsData]);
  const { data: taxRatesData } = useAccountingTaxRates();
  const taxRates = useMemo(() => taxRatesData?.data ?? [], [taxRatesData]);

  // ── What this visit did ──────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(search.lineId ?? null);
  const [mode, setMode] = useState<Mode | null>(
    MODES.includes(search.action as Mode) ? (search.action as Mode) : null,
  );
  const [done, setDone] = useState<Record<string, DoneEntry>>({});
  const [lastDoneId, setLastDoneId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<Record<string, BankLine>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rulePrefill, setRulePrefill] = useState<RuleFormPrefill | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const retained = useMemo<RetainedLine[]>(
    () => Object.values(done).map((entry) => ({ line: entry.line, index: entry.index })),
    [done],
  );
  const queue = useMemo(() => mergeQueue(serverLines, retained), [serverLines, retained]);
  const doneIds = useMemo(() => new Set(Object.keys(done)), [done]);

  // `?lineId=` may name a line that is not on a loaded page: read it by id.
  const listed = queue.find((line) => line.id === selectedId);
  const fetched = useBankLine(selectedId && !listed ? selectedId : undefined).data;
  const selectedLine = listed ?? fetched ?? null;
  useEffect(() => {
    if (!accountChoice && fetched) setAccountChoice(fetched.bankAccountId);
  }, [accountChoice, fetched]);

  // Open the first line when nothing is selected yet.
  useEffect(() => {
    if (selectedId === null && queue.length > 0) setSelectedId(nextLineId(queue, doneIds, null));
  }, [selectedId, queue, doneIds]);

  // Keep the selected line in view as J and K move through the queue.
  useEffect(() => {
    if (!selectedId) return;
    document
      .querySelector(`[data-testid="process-line-${selectedId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const selectedDone = selectedId ? (done[selectedId] ?? null) : null;
  const bannerEntry = selectedDone ?? (lastDoneId ? (done[lastDoneId] ?? null) : null);

  // ── Suggestions ──────────────────────────────────────────────────────────
  const suggestionsQuery = useBankLineSuggestions(selectedLine && !selectedDone ? selectedLine.id : null);
  const best = useMemo(() => bestSuggestion(suggestionsQuery.data ?? []), [suggestionsQuery.data]);

  // ── Mutations ────────────────────────────────────────────────────────────
  const categorize = useCategorizeBankLine();
  const transfer = useTransferBankLine();
  const markPrivate = usePrivateBankLine();
  const undo = useUndoBankLine();
  const matchPayment = useMatchBankLineToPayment();
  const matchDeposit = useMatchBankLineToDeposit();
  const reconcile = useMutation({
    mutationFn: ({ lineId, data }: { lineId: string; data: Record<string, unknown> }) =>
      accountingApi.reconcileTransaction(lineId, data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
  const exclude = useMutation({
    mutationFn: (lineId: string) => accountingApi.excludeTransaction(lineId),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
  const matching = reconcile.isPending || matchPayment.isPending || matchDeposit.isPending;

  const focusDetail = useCallback(() => {
    // The next shortcut key (Enter) must reach the page, not a button that has just gone.
    detailRef.current?.focus({ preventScroll: true });
  }, []);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMode(null);
      setActionError(null);
      setSuggestionError(null);
      focusDetail();
    },
    [focusDetail],
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

  const accountName = (id: string | null | undefined) => {
    const account = id ? ledgerAccounts.find((candidate) => candidate.id === id) : undefined;
    return account ? account.name : '';
  };

  const accept = () => {
    if (!selectedLine || !best || selectedDone || !canUpdate) return;
    setSuggestionError(null);
    const line = selectedLine;
    const text =
      best.type === 'rule'
        ? tr.suggestionRule
        : tr.suggestion.replace('{target}', suggestionTarget(best, tp.suggestion));
    const onSuccess = () => finish(line, text, 'suggestion');
    const onError = (error: unknown) => setSuggestionError(messageOf(error) || tr.failed);
    runSuggestion(line, best, onSuccess, onError);
  };

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

  const submitCategory = (input: CategorizeInput) => {
    if (!selectedLine) return;
    const line = selectedLine;
    setActionError(null);
    categorize.mutate(
      { lineId: line.id, data: input },
      {
        onSuccess: () => {
          const text =
            input.lines.length > 1
              ? tr.categoryMany.replace('{count}', String(input.lines.length))
              : tr.category.replace('{category}', accountName(input.lines[0]?.accountId));
          finish(line, text, 'category');
        },
        onError: (error) => setActionError(messageOf(error) || tr.failed),
      },
    );
  };

  const submitTransfer = (bankAccountId: string | undefined) => {
    if (!selectedLine) return;
    const line = selectedLine;
    setActionError(null);
    transfer.mutate(
      { lineId: line.id, bankAccountId },
      {
        onSuccess: (result) => {
          const other = result.counterpart
            ? bankAccounts.find((account) => account.id === result.counterpart?.bankAccountId)
            : undefined;
          finish(line, other ? tr.transferPaired.replace('{account}', other.name) : tr.transfer, 'transfer');
        },
        onError: (error) => setActionError(messageOf(error) || tr.failed),
      },
    );
  };

  const runPrivate = () => {
    if (!selectedLine || selectedDone || !canUpdate) return;
    const line = selectedLine;
    setActionError(null);
    markPrivate.mutate(line.id, {
      onSuccess: () => finish(line, tr.private, 'private'),
      onError: (error) => setActionError(messageOf(error) || tr.failed),
    });
  };

  const runIgnore = () => {
    if (!selectedLine || selectedDone || !canUpdate) return;
    const line = selectedLine;
    setActionError(null);
    exclude.mutate(line.id, {
      onSuccess: () => finish(line, tr.ignore, 'ignore'),
      onError: (error) => setActionError(messageOf(error) || tr.failed),
    });
  };

  const documentsLinked = (result: MatchDocumentsResult) => {
    if (!selectedLine) return;
    const rounding = result.roundingDifference;
    const text = rounding
      ? tr.documentsRounding.replace('{amount}', formatMoney(rounding.amount, currency))
      : tr.documents;
    finish(selectedLine, text, 'documents');
  };

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

  const openMode = (next: Mode) => {
    if (!selectedLine || selectedDone || !canUpdate) return;
    setActionError(null);
    setMode(next);
  };

  const runAction = (action: ActionId) => {
    if (action === 'private') runPrivate();
    else if (action === 'ignore') runIgnore();
    else openMode(action);
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const canAct = Boolean(selectedLine) && !selectedDone && canUpdate;
  useProcessShortcuts(view === 'toProcess' && Boolean(selectedAccountId), {
    next: () => setSelectedId((current) => stepLineId(queue, current, 1)),
    previous: () => setSelectedId((current) => stepLineId(queue, current, -1)),
    accept: canAct && best && !matching ? accept : undefined,
    category: canAct ? () => openMode('category') : undefined,
    receipt: canAct ? () => openMode('receipt') : undefined,
    transfer: canAct ? () => openMode('transfer') : undefined,
    private: canAct ? runPrivate : undefined,
    ignore: canAct ? runIgnore : undefined,
    undo: bannerEntry && canUpdate && !undo.isPending ? () => undoEntry(bannerEntry) : undefined,
    help: () => setHelpOpen(true),
    close: mode ? () => setMode(null) : undefined,
  });

  // Escape closes the open form, also from inside its fields (the shortcuts leave typing targets alone).
  // A list that is open inside the form (a select) takes the key first and marks it handled.
  useEffect(() => {
    if (!mode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isDialogOpen()) return;
      if (event.target instanceof Node && detailRef.current?.contains(event.target)) setMode(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mode]);

  const shortcutGroups = [
    {
      title: tp.shortcuts.groups.move,
      shortcuts: [
        { keys: ['J'], label: tp.shortcuts.next },
        { keys: ['K'], label: tp.shortcuts.previous },
      ],
    },
    {
      title: tp.shortcuts.groups.process,
      shortcuts: [
        { keys: ['Enter'], label: tp.shortcuts.accept },
        { keys: ['C'], label: tp.shortcuts.category },
        { keys: ['R'], label: tp.shortcuts.receipt },
        { keys: ['T'], label: tp.shortcuts.transfer },
        { keys: ['P'], label: tp.shortcuts.private },
        { keys: ['I'], label: tp.shortcuts.ignore },
        { keys: ['U'], label: tp.shortcuts.undo },
      ],
    },
    {
      title: tp.shortcuts.groups.other,
      shortcuts: [
        { keys: ['Esc'], label: tp.shortcuts.close },
        { keys: ['?'], label: tp.shortcuts.help },
      ],
    },
  ];

  // ── Bulk ─────────────────────────────────────────────────────────────────
  const bulkLines = Object.values(bulk);
  const bulkDirection: LineDirection | null = bulkLines[0] ? directionOf(bulkLines[0]) : null;
  const toggleBulk = (line: BankLine) =>
    setBulk((current) => (current[line.id] ? without(current, line.id) : { ...current, [line.id]: line }));

  const bulkBooked = (ids: string[], accountId: string) => {
    const text = tr.category.replace('{category}', accountName(accountId));
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

  // ── Rendering ────────────────────────────────────────────────────────────
  const selectAccount = (id: string) => {
    setAccountChoice(id);
    setSelectedId(null);
    setMode(null);
    setBulk({});
    setDone({});
    setLastDoneId(null);
  };

  const accountLabel = (account: (typeof bankAccounts)[number]) => {
    // The Mollie money account has no IBAN: say what it is instead.
    if (isPaymentProviderAccount(account)) return t.weldbooksPayments.bankAccount.providerOption.replace('{name}', account.name);
    return `${account.name} — ${account.accountNumberLast4 ? maskedAccountNumber(account.accountNumberLast4) : (account.iban ?? '')}`;
  };

  const tabs = [
    { id: 'toProcess', label: tp.tabs.toProcess, count: totalCount },
    { id: 'automatic', label: tp.tabs.automatic },
    { id: 'all', label: tp.tabs.all },
  ];

  const allDone = !linesQuery.isLoading && queue.length > 0 && queue.every((line) => doneIds.has(line.id));

  if (!accountsLoading && bankAccounts.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title={tp.noAccounts} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-muted-foreground">{tp.eyebrow}</span>
          <h1 className="text-[28px] font-semibold leading-9 tracking-tight">{tp.title}</h1>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="process-account" className="text-xs text-muted-foreground">
            {tp.accountLabel}
          </Label>
          <Select value={selectedAccountId} onValueChange={selectAccount}>
            <SelectTrigger id="process-account" className="w-full sm:w-80">
              <SelectValue placeholder={tp.selectAccount} />
            </SelectTrigger>
            <SelectContent>
              {bankAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <nav aria-label={tp.navLabel}>
        <PageTabs
          tabs={tabs}
          activeTab={view}
          onTabChange={(id) => {
            if (id === 'all') {
              void navigate({ to: '/weldbooks/banking/transactions' });
            } else {
              setView(id === 'automatic' ? 'automatic' : 'toProcess');
            }
          }}
        />
      </nav>

      {view === 'automatic' ? (
        selectedAccountId ? (
          <AutomaticView bankAccountId={selectedAccountId} currency={currency} />
        ) : null
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-3 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto lg:pr-1">
            {bulkLines.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
                data-testid="bulk-bar"
              >
                <span className="flex-1 font-medium">{tp.bulk.selected.replace('{count}', String(bulkLines.length))}</span>
                <Button type="button" size="sm" onClick={() => setBulkOpen(true)} data-testid="bulk-open">
                  {tp.bulk.book}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setBulk({})}>
                  {tp.bulk.clear}
                </Button>
              </div>
            ) : null}
            <QueueList
              lines={queue}
              totalCount={totalCount}
              selectedId={selectedId}
              doneIds={doneIds}
              bulkIds={new Set(Object.keys(bulk))}
              bulkDirection={bulkDirection}
              canBulk={canUpdate}
              isLoading={linesQuery.isLoading}
              isError={linesQuery.isError}
              hasNextPage={Boolean(linesQuery.hasNextPage)}
              isFetchingNextPage={linesQuery.isFetchingNextPage}
              search={lineSearch}
              onSearchChange={setLineSearch}
              onSelect={select}
              onToggleBulk={toggleBulk}
              onLoadMore={() => void linesQuery.fetchNextPage()}
              formatAmount={(amount) => formatMoney(amount, currency)}
              formatDate={formatDate}
            />
          </div>

          <div
            ref={detailRef}
            tabIndex={-1}
            role="region"
            aria-label={tp.selectedLabel}
            className="flex min-w-0 flex-col gap-4 outline-none"
            data-testid="process-detail"
          >
            {allDone ? (
              <p
                className="rounded-xl bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                role="status"
                data-testid="all-done"
              >
                {tp.allDone}
              </p>
            ) : null}

            {notice ? (
              <p className="text-sm text-muted-foreground" role="status" data-testid="undo-notice">
                {notice}
              </p>
            ) : null}

            {bannerEntry ? (
              <>
                <ResultBanner
                  text={bannerEntry.text}
                  canUndo={canUpdate}
                  undoPending={undo.isPending}
                  errorMessage={actionError && !selectedLine ? actionError : null}
                  onUndo={() => undoEntry(bannerEntry)}
                />
                {bannerEntry.kind === 'category' ? (
                  <RuleOffer
                    lineId={bannerEntry.line.id}
                    counterpartyName={bannerEntry.line.counterpartyName}
                    canCreate={can('banking:update')}
                    onMakeRule={setRulePrefill}
                  />
                ) : null}
              </>
            ) : null}

            {selectedLine ? (
              <>
                <LineHeader
                  line={selectedLine}
                  accountName={bankAccounts.find((a) => a.id === selectedLine.bankAccountId)?.name ?? selectedAccount?.name ?? null}
                  amountLabel={formatMoney(selectedLine.amount, currency)}
                  dateLabel={formatDate(selectedLine.date)}
                />

                {!selectedDone ? (
                  <SuggestionCard
                    suggestion={best}
                    loading={suggestionsQuery.isLoading}
                    formatAmount={(amount) => formatMoney(amount, currency)}
                    pending={matching}
                    readOnly={!canUpdate}
                    errorMessage={suggestionError}
                    onAccept={accept}
                    onSearch={() => openMode('several')}
                  />
                ) : null}

                {!selectedDone && mode === 'category' ? (
                  <CategoryForm
                    key={selectedLine.id}
                    line={selectedLine}
                    currency={currency}
                    accounts={ledgerAccounts}
                    taxRates={taxRates}
                    pending={categorize.isPending}
                    errorMessage={actionError}
                    onSubmit={submitCategory}
                    onCancel={() => setMode(null)}
                  />
                ) : null}
                {!selectedDone && mode === 'receipt' ? (
                  <ReceiptForm
                    key={selectedLine.id}
                    lineId={selectedLine.id}
                    lineDate={selectedLine.date}
                    onBookNow={() => setMode('category')}
                    onClose={() => setMode(null)}
                    onBooked={() => finish(selectedLine, tr.receiptBooked, 'documents')}
                  />
                ) : null}
                {!selectedDone && mode === 'transfer' ? (
                  <TransferForm
                    key={selectedLine.id}
                    line={selectedLine}
                    accounts={bankAccounts}
                    pending={transfer.isPending}
                    errorMessage={actionError}
                    onSubmit={submitTransfer}
                    onCancel={() => setMode(null)}
                  />
                ) : null}
                {!selectedDone && mode === 'several' ? (
                  <div className="rounded-xl border p-5" data-testid="several-panel">
                    <MatchDocumentsPanel
                      key={selectedLine.id}
                      lineId={selectedLine.id}
                      lineAmount={selectedLine.amount}
                      currency={currency}
                      ledgerAccounts={ledgerAccounts}
                      readOnly={!canUpdate}
                      onMatched={documentsLinked}
                    />
                  </div>
                ) : null}

                {!selectedDone ? (
                  <>
                    {actionError && mode === null ? (
                      <p className="text-sm text-destructive" role="alert" data-testid="action-error">
                        {actionError}
                      </p>
                    ) : null}
                    <ActionGrid disabled={!canUpdate} active={mode} onRun={runAction} />
                  </>
                ) : null}

                <ConnectionsStrip
                  lineId={selectedLine.id}
                  amountLabel={formatMoney(selectedLine.amount, currency)}
                  currency={currency}
                />
                <HintRow />
              </>
            ) : (
              !linesQuery.isLoading && !allDone && <p className="text-sm text-muted-foreground">{tp.pickALine}</p>
            )}
          </div>
        </div>
      )}

      <KeyboardHelp
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title={tp.shortcuts.title}
        description={tp.shortcuts.description}
        groups={shortcutGroups}
      />
      <BulkCategorizeDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        lines={bulkLines}
        accounts={ledgerAccounts}
        taxRates={taxRates}
        onBooked={bulkBooked}
      />
      <ReconciliationRuleFormDialog
        open={rulePrefill !== null}
        onOpenChange={(open) => {
          if (!open) setRulePrefill(null);
        }}
        prefill={rulePrefill}
      />
    </div>
  );
}
