/**
 * State of the processing view: the chosen account, what this visit did, the
 * queue of lines and the selected line. The actions on top of it are in
 * `use-process-actions.ts`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccountingAccounts, useAccountingTaxRates } from '@/hooks/queries/use-accounting-queries';
import { useBankAccounts, useBankLine, useInfiniteBankLines } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useDebounce } from '@/hooks/use-debounce';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import type { RuleFormPrefill } from '@/lib/api/domains/weldbooks-processing';
import {
  doneEntriesOf,
  initialMode,
  type DoneEntry,
  type Mode,
  type ProcessSearch,
} from './process-helpers';
import { mergeQueue, nextLineId, type RetainedLine } from './process-model';

/** The bank accounts and the one the queue is for. */
export function useProcessAccount(search: ProcessSearch, entityCurrency: string) {
  const { data, isLoading: accountsLoading } = useBankAccounts();
  const bankAccounts = useMemo(() => data?.data ?? [], [data]);
  const [accountChoice, setAccountChoice] = useState(search.accountId ?? '');
  const defaultId = bankAccounts.find((account) => account.isDefault)?.id ?? bankAccounts[0]?.id ?? '';
  const selectedAccountId = accountChoice || defaultId;
  const selectedAccount = bankAccounts.find((account) => account.id === selectedAccountId);
  const currency = selectedAccount?.currency || entityCurrency;
  return { bankAccounts, accountsLoading, accountChoice, setAccountChoice, selectedAccountId, selectedAccount, currency };
}

/** The chart of accounts and tax rates the forms pick from. */
export function useProcessLedger() {
  const { data: accountsData } = useAccountingAccounts();
  const ledgerAccounts = useMemo(() => (accountsData?.data ?? []) as Account[], [accountsData]);
  const { data: taxRatesData } = useAccountingTaxRates();
  const taxRates = useMemo(() => taxRatesData?.data ?? [], [taxRatesData]);
  return { ledgerAccounts, taxRates };
}

/** What this visit did and what is open. */
export function useProcessState(search: ProcessSearch) {
  const [view, setView] = useState<'toProcess' | 'automatic'>(search.view === 'automatic' ? 'automatic' : 'toProcess');
  const [selectedId, setSelectedId] = useState<string | null>(search.lineId ?? null);
  const [mode, setMode] = useState<Mode | null>(initialMode(search.action));
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
  return {
    view, setView, selectedId, setSelectedId, mode, setMode, done, setDone, lastDoneId, setLastDoneId,
    notice, setNotice, actionError, setActionError, suggestionError, setSuggestionError,
    bulk, setBulk, bulkOpen, setBulkOpen, helpOpen, setHelpOpen, rulePrefill, setRulePrefill, detailRef,
  };
}

export type ProcessState = ReturnType<typeof useProcessState>;

/** The unprocessed lines of the account, with the lines processed in this visit kept in place. */
export function useProcessQueue(selectedAccountId: string, done: Record<string, DoneEntry>) {
  const [lineSearch, setLineSearch] = useState('');
  const debouncedSearch = useDebounce(lineSearch.trim(), 300);
  const linesQuery = useInfiniteBankLines(
    selectedAccountId
      ? { bankAccountId: selectedAccountId, status: 'unreconciled', search: debouncedSearch || undefined }
      : undefined,
  );
  const serverLines = useMemo(() => linesQuery.data?.lines ?? [], [linesQuery.data]);
  const totalCount = linesQuery.data?.totalCount ?? 0;
  const retained = useMemo<RetainedLine[]>(
    () => Object.values(done).map((entry) => ({ line: entry.line, index: entry.index })),
    [done],
  );
  const queue = useMemo(() => mergeQueue(serverLines, retained), [serverLines, retained]);
  const doneIds = useMemo(() => new Set(Object.keys(done)), [done]);
  const allDone = !linesQuery.isLoading && queue.length > 0 && queue.every((line) => doneIds.has(line.id));
  return { lineSearch, setLineSearch, linesQuery, totalCount, queue, doneIds, allDone };
}

/** Keep the selected line in view as J and K move through the queue. */
function useScrollSelectedIntoView(selectedId: string | null) {
  useEffect(() => {
    if (!selectedId) return;
    document
      .querySelector(`[data-testid="process-line-${selectedId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);
}

/** Open the first line when nothing is selected yet. */
function useOpenFirstLine(state: ProcessState, queue: BankLine[], doneIds: Set<string>) {
  const { selectedId, setSelectedId } = state;
  useEffect(() => {
    if (selectedId === null && queue.length > 0) setSelectedId(nextLineId(queue, doneIds, null));
  }, [selectedId, setSelectedId, queue, doneIds]);
}

/** The selected line, the Done entry of it and the one whose banner shows. */
export function useSelectedLine(
  state: ProcessState,
  queue: BankLine[],
  doneIds: Set<string>,
  account: { accountChoice: string; setAccountChoice: (id: string) => void },
) {
  const { selectedId, done, lastDoneId } = state;
  const { accountChoice, setAccountChoice } = account;
  // `?lineId=` may name a line that is not on a loaded page: read it by id.
  const listed = queue.find((line) => line.id === selectedId);
  const fetched = useBankLine(selectedId && !listed ? selectedId : undefined).data;
  const selectedLine = listed ?? fetched ?? null;
  useEffect(() => {
    if (!accountChoice && fetched) setAccountChoice(fetched.bankAccountId);
  }, [accountChoice, fetched, setAccountChoice]);
  useOpenFirstLine(state, queue, doneIds);
  useScrollSelectedIntoView(selectedId);
  return { selectedLine, ...doneEntriesOf(done, selectedId, lastDoneId) };
}
