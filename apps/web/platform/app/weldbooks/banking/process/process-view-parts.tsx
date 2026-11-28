/**
 * The pieces of the processing view (`process-view.tsx`): the header with the
 * account picker, the tabs, the queue column and the detail column.
 */

import type { ComponentProps, ReactNode, RefObject } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { Label } from '@weldsuite/ui/components/label';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { AskQuestionButton } from '@/components/accounting/questions/ask-question-button';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { BankLine, MatchDocumentsResult, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import type { CategorizeInput, RuleFormPrefill } from '@/lib/api/domains/weldbooks-processing';
import { useI18n } from '@/lib/i18n/provider';
import { isPaymentProviderAccount } from '@/lib/weldbooks/online-payments';
import { MatchDocumentsPanel } from '../components/match-documents-panel';
import { maskedAccountNumber } from '../components/routing-number';
import { CategoryForm } from './category-form';
import { ConnectionsStrip } from './connections-strip';
import { ActionGrid, HintRow, LineHeader, ResultBanner, type ActionId } from './line-parts';
import type { DoneEntry, Mode } from './process-helpers';
import { QueueList } from './queue-list';
import { ReceiptForm } from './receipt-form';
import { RuleOffer } from './rule-offer';
import { SuggestionCard } from './suggestion-card';
import { TransferForm } from './transfer-form';
import type { useProcessAccount } from './use-process-state';

type BankAccounts = ReturnType<typeof useProcessAccount>['bankAccounts'];

export function NoAccounts() {
  const { t } = useI18n();
  return (
    <div className="p-6">
      <EmptyState title={t.weldbooksConnected.processing.noAccounts} />
    </div>
  );
}

export function ProcessHeader({
  bankAccounts,
  selectedAccountId,
  onSelectAccount,
}: Readonly<{ bankAccounts: BankAccounts; selectedAccountId: string; onSelectAccount: (id: string) => void }>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;

  const accountLabel = (account: BankAccounts[number]) => {
    // The Mollie money account has no IBAN: say what it is instead.
    if (isPaymentProviderAccount(account)) return t.weldbooksPayments.bankAccount.providerOption.replace('{name}', account.name);
    return `${account.name} — ${account.accountNumberLast4 ? maskedAccountNumber(account.accountNumberLast4) : (account.iban ?? '')}`;
  };

  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-muted-foreground">{tp.eyebrow}</span>
        <h1 className="text-[28px] font-semibold leading-9 tracking-tight">{tp.title}</h1>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="process-account" className="text-xs text-muted-foreground">
          {tp.accountLabel}
        </Label>
        <Select value={selectedAccountId} onValueChange={onSelectAccount}>
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
  );
}

export function ProcessTabs({
  view,
  totalCount,
  onViewChange,
  onOpenAll,
}: Readonly<{
  view: 'toProcess' | 'automatic';
  totalCount: number;
  onViewChange: (view: 'toProcess' | 'automatic') => void;
  onOpenAll: () => void;
}>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  const tabs = [
    { id: 'toProcess', label: tp.tabs.toProcess, count: totalCount },
    { id: 'automatic', label: tp.tabs.automatic },
    { id: 'all', label: tp.tabs.all },
  ];
  const onTabChange = (id: string) => {
    if (id === 'all') onOpenAll();
    else onViewChange(id === 'automatic' ? 'automatic' : 'toProcess');
  };
  return (
    <nav aria-label={tp.navLabel}>
      <PageTabs tabs={tabs} activeTab={view} onTabChange={onTabChange} />
    </nav>
  );
}

export function BulkBar({
  count,
  onOpen,
  onClear,
}: Readonly<{ count: number; onOpen: () => void; onClear: () => void }>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      data-testid="bulk-bar"
    >
      <span className="flex-1 font-medium">{tp.bulk.selected.replace('{count}', String(count))}</span>
      <Button type="button" size="sm" onClick={onOpen} data-testid="bulk-open">
        {tp.bulk.book}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClear}>
        {tp.bulk.clear}
      </Button>
    </div>
  );
}

export type QueueColumnProps = Readonly<{
  bulkCount: number;
  onOpenBulk: () => void;
  onClearBulk: () => void;
  list: ComponentProps<typeof QueueList>;
}>;

export function QueueColumn({ bulkCount, onOpenBulk, onClearBulk, list }: QueueColumnProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto lg:pr-1">
      {bulkCount > 0 ? <BulkBar count={bulkCount} onOpen={onOpenBulk} onClear={onClearBulk} /> : null}
      <QueueList {...list} />
    </div>
  );
}

interface ModePanelProps {
  line: BankLine;
  mode: Mode | null;
  currency: string;
  ledgerAccounts: Account[];
  taxRates: ComponentProps<typeof CategoryForm>['taxRates'];
  bankAccounts: BankAccounts;
  canUpdate: boolean;
  actionError: string | null;
  categorizePending: boolean;
  transferPending: boolean;
  onSetMode: (mode: Mode | null) => void;
  onSubmitCategory: (input: CategorizeInput) => void;
  onSubmitTransfer: (bankAccountId: string | undefined) => void;
  onReceiptBooked: () => void;
  onDocumentsLinked: (result: MatchDocumentsResult) => void;
}

/** The form of the open mode (category, receipt, transfer or several documents), if any. */
function ModePanel(p: Readonly<ModePanelProps>) {
  const { line, mode, currency, onSetMode } = p;
  const close = () => onSetMode(null);
  switch (mode) {
    case 'category':
      return (
        <CategoryForm
          key={line.id}
          line={line}
          currency={currency}
          accounts={p.ledgerAccounts}
          taxRates={p.taxRates}
          pending={p.categorizePending}
          errorMessage={p.actionError}
          onSubmit={p.onSubmitCategory}
          onCancel={close}
        />
      );
    case 'receipt':
      return (
        <ReceiptForm
          key={line.id}
          lineId={line.id}
          lineDate={line.date}
          onBookNow={() => onSetMode('category')}
          onClose={close}
          onBooked={p.onReceiptBooked}
        />
      );
    case 'transfer':
      return (
        <TransferForm
          key={line.id}
          line={line}
          accounts={p.bankAccounts}
          pending={p.transferPending}
          errorMessage={p.actionError}
          onSubmit={p.onSubmitTransfer}
          onCancel={close}
        />
      );
    case 'several':
      return (
        <div className="rounded-xl border p-5" data-testid="several-panel">
          <MatchDocumentsPanel
            key={line.id}
            lineId={line.id}
            lineAmount={line.amount}
            currency={currency}
            ledgerAccounts={p.ledgerAccounts}
            readOnly={!p.canUpdate}
            onMatched={p.onDocumentsLinked}
          />
        </div>
      );
    default:
      return null;
  }
}

/** What can still be done to an open line: the forms, the "Or" actions and the accountant question. */
function OpenLineActions({
  line,
  mode,
  canUpdate,
  actionError,
  onRunAction,
  modePanel,
}: Readonly<{
  line: BankLine;
  mode: Mode | null;
  canUpdate: boolean;
  actionError: string | null;
  onRunAction: (action: ActionId) => void;
  modePanel: ModePanelProps;
}>) {
  const { t } = useI18n();
  return (
    <>
      <ModePanel {...modePanel} />
      {actionError && mode === null ? (
        <p className="text-sm text-destructive" role="alert" data-testid="action-error">
          {actionError}
        </p>
      ) : null}
      <ActionGrid disabled={!canUpdate} active={mode} onRun={onRunAction} />
      {/* "Ask your accountant": what was this payment? (edition feature `books-questions`) */}
      <div className="flex justify-start">
        <AskQuestionButton
          recordType="bank_transaction"
          recordId={line.id}
          label={t.weldbooksQuestions.processing.ask}
          defaultText={t.weldbooksQuestions.processing.askDefaultText}
          testId="process-ask-question"
        />
      </div>
    </>
  );
}

export interface SelectedLinePanelProps {
  line: BankLine;
  headerAccountName: string | null;
  isDone: boolean;
  mode: Mode | null;
  canUpdate: boolean;
  actionError: string | null;
  suggestionError: string | null;
  best: MatchSuggestion | null;
  suggestionsLoading: boolean;
  matching: boolean;
  currency: string;
  formatMoney: (amount: string | number, currency?: string) => string;
  formatDate: (date: string) => string;
  onAccept: () => void;
  onOpenSeveral: () => void;
  onRunAction: (action: ActionId) => void;
  modePanel: ModePanelProps;
}

export type { ModePanelProps };

/** The selected line: header, best suggestion, the open form and actions, Connections. */
export function SelectedLinePanel(p: Readonly<SelectedLinePanelProps>) {
  const { line, currency, formatMoney } = p;
  return (
    <>
      <LineHeader
        line={line}
        accountName={p.headerAccountName}
        amountLabel={formatMoney(line.amount, currency)}
        dateLabel={p.formatDate(line.date)}
      />

      {p.isDone ? null : (
        <>
          <SuggestionCard
            suggestion={p.best}
            loading={p.suggestionsLoading}
            formatAmount={(amount) => formatMoney(amount, currency)}
            pending={p.matching}
            readOnly={!p.canUpdate}
            errorMessage={p.suggestionError}
            onAccept={p.onAccept}
            onSearch={p.onOpenSeveral}
          />
          <OpenLineActions
            line={line}
            mode={p.mode}
            canUpdate={p.canUpdate}
            actionError={p.actionError}
            onRunAction={p.onRunAction}
            modePanel={p.modePanel}
          />
        </>
      )}

      <ConnectionsStrip lineId={line.id} amountLabel={formatMoney(line.amount, currency)} currency={currency} />
      <HintRow />
    </>
  );
}

/** The success line of the last processed line, with its Undo and the offer to make a rule. */
function DetailBanner({
  entry,
  canUpdate,
  undoPending,
  errorMessage,
  onUndo,
  onMakeRule,
}: Readonly<{
  entry: DoneEntry;
  canUpdate: boolean;
  undoPending: boolean;
  errorMessage: string | null;
  onUndo: (entry: DoneEntry) => void;
  onMakeRule: (prefill: RuleFormPrefill) => void;
}>) {
  return (
    <>
      <ResultBanner
        text={entry.text}
        canUndo={canUpdate}
        undoPending={undoPending}
        errorMessage={errorMessage}
        onUndo={() => onUndo(entry)}
      />
      {entry.kind === 'category' ? (
        <RuleOffer
          lineId={entry.line.id}
          counterpartyName={entry.line.counterpartyName}
          canCreate={canUpdate}
          onMakeRule={onMakeRule}
        />
      ) : null}
    </>
  );
}

export interface DetailColumnProps {
  detailRef: RefObject<HTMLDivElement | null>;
  allDone: boolean;
  notice: string | null;
  linesLoading: boolean;
  hasSelectedLine: boolean;
  bannerEntry: DoneEntry | null;
  canUpdate: boolean;
  undoPending: boolean;
  /** The banner carries the action error only when no line is open to show it. */
  bannerError: string | null;
  onUndo: (entry: DoneEntry) => void;
  onMakeRule: (prefill: RuleFormPrefill) => void;
  children: ReactNode;
}

export function DetailColumn(p: Readonly<DetailColumnProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  return (
    <div
      ref={p.detailRef}
      tabIndex={-1}
      role="region"
      aria-label={tp.selectedLabel}
      className="flex min-w-0 flex-col gap-4 outline-none"
      data-testid="process-detail"
    >
      {p.allDone ? (
        <p
          className="rounded-xl bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          role="status"
          data-testid="all-done"
        >
          {tp.allDone}
        </p>
      ) : null}

      {p.notice ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="undo-notice">
          {p.notice}
        </p>
      ) : null}

      {p.bannerEntry ? (
        <DetailBanner
          entry={p.bannerEntry}
          canUpdate={p.canUpdate}
          undoPending={p.undoPending}
          errorMessage={p.bannerError}
          onUndo={p.onUndo}
          onMakeRule={p.onMakeRule}
        />
      ) : null}

      {p.hasSelectedLine ? p.children : null}
      {!p.hasSelectedLine && !p.linesLoading && !p.allDone ? (
        <p className="text-sm text-muted-foreground">{tp.pickALine}</p>
      ) : null}
    </div>
  );
}

