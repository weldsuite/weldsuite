/**
 * The processing view (phase 2): Bank → Transactions → To process. The queue
 * of unprocessed lines is on the left, the selected line on the right with its
 * best suggestion as one button (Enter), the "Or" actions with shortcut keys
 * and the Connections strip. After every action the line is marked Done and
 * the next one opens; the success line carries the one Undo.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { usePermissions } from '@weldsuite/permissions/react';
import { KeyboardHelp } from '@weldsuite/ui/components/keyboard-help';
import { ReconciliationRuleFormDialog } from '@/components/accounting/reconciliation-rule-form-dialog';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { useBankLineSuggestions } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { AutomaticView } from './automatic-view';
import { BulkCategorizeDialog } from './bulk-categorize-dialog';
import { type ProcessSearch } from './process-helpers';
import { bestSuggestion } from './process-model';
import {
  DetailColumn,
  NoAccounts,
  ProcessHeader,
  ProcessTabs,
  QueueColumn,
  SelectedLinePanel,
} from './process-view-parts';
import { useProcessActions } from './use-process-actions';
import {
  useProcessAccount,
  useProcessLedger,
  useProcessQueue,
  useProcessState,
  useSelectedLine,
} from './use-process-state';

export type { ProcessSearch };

export function ProcessView() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ProcessSearch;
  const { t } = useI18n();
  const tp = t.weldbooksConnected.processing;
  const { can } = usePermissions();
  const canUpdate = can('banking:update');
  const { formatMoney, formatDate, currency: entityCurrency } = useWeldbooksFormat();
  useObjectPanelUrlSync('/weldbooks/banking/process');

  const account = useProcessAccount(search, entityCurrency);
  const { bankAccounts, selectedAccountId, selectedAccount, currency } = account;
  const { ledgerAccounts, taxRates } = useProcessLedger();
  const state = useProcessState(search);
  const { view, setView, mode, setMode, setBulk, selectedId, setSelectedId } = state;
  const { lineSearch, setLineSearch, linesQuery, totalCount, queue, doneIds, allDone } = useProcessQueue(
    selectedAccountId,
    state.done,
  );
  const { selectedLine, selectedDone, bannerEntry } = useSelectedLine(state, queue, doneIds, account);

  const suggestionsQuery = useBankLineSuggestions(selectedLine && !selectedDone ? selectedLine.id : null);
  const best = bestSuggestion(suggestionsQuery.data ?? []);
  const formatAmount = (amount: string | number) => formatMoney(amount, currency);

  const actions = useProcessActions({
    state,
    copy: tp,
    queue,
    doneIds,
    selectedLine,
    selectedDone,
    bannerEntry,
    best,
    canUpdate,
    keyboardEnabled: view === 'toProcess' && Boolean(selectedAccountId),
    ledgerAccounts,
    bankAccounts,
    formatAmount,
  });

  const selectAccount = (id: string) => {
    account.setAccountChoice(id);
    setSelectedId(null);
    setMode(null);
    setBulk({});
    state.setDone({});
    state.setLastDoneId(null);
  };

  if (!account.accountsLoading && bankAccounts.length === 0) return <NoAccounts />;

  return (
    <div className="flex flex-col gap-5 p-6">
      <ProcessHeader bankAccounts={bankAccounts} selectedAccountId={selectedAccountId} onSelectAccount={selectAccount} />
      <ProcessTabs
        view={view}
        totalCount={totalCount}
        onViewChange={setView}
        onOpenAll={() => void navigate({ to: '/weldbooks/banking/transactions' })}
      />

      {view === 'automatic' ? (
        <AutomaticBody accountId={selectedAccountId} currency={currency} />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
          <QueueColumn
            bulkCount={actions.bulkLines.length}
            onOpenBulk={() => state.setBulkOpen(true)}
            onClearBulk={() => setBulk({})}
            list={{
              lines: queue,
              totalCount,
              selectedId,
              doneIds,
              bulkIds: actions.bulkIds,
              bulkDirection: actions.bulkDirection,
              canBulk: canUpdate,
              isLoading: linesQuery.isLoading,
              isError: linesQuery.isError,
              hasNextPage: Boolean(linesQuery.hasNextPage),
              isFetchingNextPage: linesQuery.isFetchingNextPage,
              search: lineSearch,
              onSearchChange: setLineSearch,
              onSelect: actions.select,
              onToggleBulk: actions.toggleBulk,
              onLoadMore: () => void linesQuery.fetchNextPage(),
              formatAmount,
              formatDate,
            }}
          />
          <DetailColumn
            detailRef={state.detailRef}
            allDone={allDone}
            notice={state.notice}
            linesLoading={linesQuery.isLoading}
            hasSelectedLine={selectedLine !== null}
            bannerEntry={bannerEntry}
            canUpdate={canUpdate}
            undoPending={actions.undoPending}
            bannerError={selectedLine ? null : state.actionError}
            onUndo={actions.undoEntry}
            onMakeRule={state.setRulePrefill}
          >
            {selectedLine ? (
              <SelectedLinePanel
                line={selectedLine}
                headerAccountName={
                  bankAccounts.find((a) => a.id === selectedLine.bankAccountId)?.name ?? selectedAccount?.name ?? null
                }
                isDone={selectedDone !== null}
                mode={mode}
                canUpdate={canUpdate}
                actionError={state.actionError}
                suggestionError={state.suggestionError}
                best={best}
                suggestionsLoading={suggestionsQuery.isLoading}
                matching={actions.matching}
                currency={currency}
                formatMoney={formatMoney}
                formatDate={formatDate}
                onAccept={actions.accept}
                onOpenSeveral={() => actions.openMode('several')}
                onRunAction={actions.runAction}
                modePanel={{
                  line: selectedLine,
                  mode,
                  currency,
                  ledgerAccounts,
                  taxRates,
                  bankAccounts,
                  canUpdate,
                  actionError: state.actionError,
                  categorizePending: actions.categorizePending,
                  transferPending: actions.transferPending,
                  onSetMode: setMode,
                  onSubmitCategory: actions.submitCategory,
                  onSubmitTransfer: actions.submitTransfer,
                  onReceiptBooked: () => actions.finish(selectedLine, tp.result.receiptBooked, 'documents'),
                  onDocumentsLinked: actions.documentsLinked,
                }}
              />
            ) : null}
          </DetailColumn>
        </div>
      )}

      <KeyboardHelp
        open={state.helpOpen}
        onOpenChange={state.setHelpOpen}
        title={tp.shortcuts.title}
        description={tp.shortcuts.description}
        groups={shortcutGroups(tp)}
      />
      <BulkCategorizeDialog
        open={state.bulkOpen}
        onOpenChange={state.setBulkOpen}
        lines={actions.bulkLines}
        accounts={ledgerAccounts}
        taxRates={taxRates}
        onBooked={actions.bulkBooked}
      />
      <ReconciliationRuleFormDialog
        open={state.rulePrefill !== null}
        onOpenChange={(open) => {
          if (!open) state.setRulePrefill(null);
        }}
        prefill={state.rulePrefill}
      />
    </div>
  );
}

function AutomaticBody({ accountId, currency }: Readonly<{ accountId: string; currency: string }>) {
  return accountId ? <AutomaticView bankAccountId={accountId} currency={currency} /> : null;
}

function shortcutGroups(tp: ReturnType<typeof useI18n>['t']['weldbooksConnected']['processing']) {
  return [
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
}
