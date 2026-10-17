import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ClipboardCheck, EllipsisVertical, FileText, Loader2, Play, Undo2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { ActiveFilter, ColumnDef, FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowAmount, RowDate, RowTitle, StatusChip, type ChipTone } from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  useBankAccounts,
  useBankReconciliations,
  useDiscardBankReconciliation,
  useStartBankReconciliation,
  useUndoBankReconciliation,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import {
  errorDetails,
  isLiabilityAccountType,
  isWeldbooksRequestError,
  type ReconciliationHistoryRow,
  type ReconciliationStatus,
} from '@/lib/api/domains/weldbooks-banking';
import { maskedAccountNumber } from '../components/routing-number';
import { inProgressOf, latestCompleted, parseStatementBalance } from './reconciliation-math';

const STATUSES: readonly ReconciliationStatus[] = ['in_progress', 'completed', 'undone'];

/** Client-side filtering of the history on its status pill (`is` / `is not`). */
function filterByStatus(rows: ReconciliationHistoryRow[], active: ActiveFilter[]): ReconciliationHistoryRow[] {
  return active.reduce((kept, pill) => {
    if (pill.field !== 'status' || pill.value === '') return kept;
    if (pill.operator === 'is') return kept.filter((row) => row.status === pill.value);
    if (pill.operator === 'is not') return kept.filter((row) => row.status !== pill.value);
    return kept;
  }, rows);
}

const STATUS_TONE: Record<ReconciliationStatus, ChipTone> = {
  completed: 'green',
  undone: 'gray',
  in_progress: 'amber',
};

export default function StatementReconciliationsPage() {
  const { t } = useI18n();
  const ts = t.weldbooksUs.banking.statements;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { accountId?: string };
  const { can } = usePermissions();
  const { formatMoney, formatDate, formatDateTime, today, entityCurrency } = useWeldbooksFormat();

  const { data: accountsRes, isLoading: accountsLoading } = useBankAccounts();
  const accounts = useMemo(() => (accountsRes?.data ?? []).filter((a) => a.isActive !== false), [accountsRes]);

  const [accountId, setAccountId] = useState(search.accountId ?? '');
  const [statementDate, setStatementDate] = useState(() => today());
  const [endingBalance, setEndingBalance] = useState('');
  const [beginningBalance, setBeginningBalance] = useState('0.00');
  const [showProblems, setShowProblems] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [discardId, setDiscardId] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accountId, accounts]);

  const account = accounts.find((a) => a.id === accountId);
  const liability = isLiabilityAccountType(account?.accountType);
  const currency = account?.currency ?? entityCurrency;

  const history = useBankReconciliations(accountId ? { bankAccountId: accountId, pageSize: 100 } : undefined);
  const rows = useMemo(() => history.data?.data ?? [], [history.data]);
  const open = inProgressOf(rows, accountId);
  const latest = latestCompleted(rows, accountId);

  const start = useStartBankReconciliation();
  const undo = useUndoBankReconciliation();
  const discard = useDiscardBankReconciliation();

  const ending = parseStatementBalance(endingBalance);
  const beginning = parseStatementBalance(beginningBalance);
  const dateAfterLast = !latest || statementDate > latest.statementDate;
  const startProblem = ending === null || !statementDate || !dateAfterLast || (!latest && beginning === null);

  const conflictId =
    start.isError && isWeldbooksRequestError(start.error) && start.error.status === 409
      ? String(errorDetails(start.error)?.reconciliationId ?? '')
      : '';

  const submit = () => {
    if (startProblem || ending === null) {
      setShowProblems(true);
      return;
    }
    start.mutate(
      {
        bankAccountId: accountId,
        statementDate,
        statementEndingBalance: ending,
        ...(!latest && beginning !== null ? { beginningBalance: beginning } : {}),
      },
      { onSuccess: (view) => navigate({ to: '/weldbooks/banking/statements/$id', params: { id: view.id } }) },
    );
  };

  const accountLabel = (a: (typeof accounts)[number]) =>
    a.accountNumberLast4 ? `${a.name} · ${maskedAccountNumber(a.accountNumberLast4)}` : a.name;

  const problemText = dateAfterLast ? ts.problemBalances : ts.problemDate.replace('{date}', formatDate(latest?.statementDate));

  let startSection: ReactNode = null;
  if (accountId && open) {
    startSection = (
      <Card data-testid="in-progress">
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
          <p className="min-w-[16rem] flex-1 text-sm">{ts.inProgress.replace('{date}', formatDate(open.statementDate))}</p>
          <Button asChild>
            <Link to="/weldbooks/banking/statements/$id" params={{ id: open.id }}>{ts.resume}</Link>
          </Button>
          {can('banking:update') ? (
            <Button variant="outline" onClick={() => setDiscardId(open.id)}>{ts.discard}</Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else if (accountId) {
    startSection = (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{ts.startTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="statement-date">{liability ? ts.statementDateCard : ts.statementDate}</Label>
              <Input id="statement-date" type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="statement-ending">{liability ? ts.endingBalanceOwed : ts.endingBalance}</Label>
              <Input
                id="statement-ending"
                inputMode="decimal"
                value={endingBalance}
                placeholder="0.00"
                onChange={(e) => setEndingBalance(e.target.value)}
                data-testid="statement-ending-balance"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="statement-beginning">{liability ? ts.beginningBalanceOwed : ts.beginningBalance}</Label>
              {latest ? (
                <p id="statement-beginning" className="flex h-9 items-center text-sm font-medium tabular-nums" data-testid="statement-beginning-fixed">
                  {formatMoney(latest.statementEndingBalance, currency)}
                </p>
              ) : (
                <Input
                  id="statement-beginning"
                  inputMode="decimal"
                  value={beginningBalance}
                  onChange={(e) => setBeginningBalance(e.target.value)}
                  data-testid="statement-beginning-balance"
                />
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {latest ? ts.nextHint.replace('{date}', formatDate(latest.statementDate)) : ts.firstHint}
          </p>
          {showProblems && startProblem ? (
            <p className="text-sm text-destructive" role="alert">{problemText}</p>
          ) : null}
          {start.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {(start.error as Error).message}{' '}
              {conflictId ? (
                <Link to="/weldbooks/banking/statements/$id" params={{ id: conflictId }} className="underline">
                  {ts.resume}
                </Link>
              ) : null}
            </p>
          ) : null}
          <Button onClick={submit} disabled={start.isPending || !can('banking:create') || !account} data-testid="start-reconciliation">
            {start.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {ts.start}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statusFilters: FilterConfig[] = [
    { field: 'status', label: ts.columns.status, options: STATUSES.map((value) => ({ value, label: ts.statuses[value] })) },
  ];

  const openRow = (row: ReconciliationHistoryRow) => {
    if (row.status !== 'in_progress' && row.hasReport) {
      void navigate({ to: '/weldbooks/banking/statements/$id/report', params: { id: row.id } });
    } else {
      void navigate({ to: '/weldbooks/banking/statements/$id', params: { id: row.id } });
    }
  };

  const columns: ColumnDef<ReconciliationHistoryRow>[] = [
    {
      id: 'statementDate',
      header: ts.columns.statementDate,
      width: 'min-w-[160px] flex-1 gap-2',
      render: (row) => <RowTitle>{formatDate(row.statementDate)}</RowTitle>,
    },
    {
      id: 'endingBalance',
      header: ts.columns.endingBalance,
      width: 'w-[140px]',
      render: (row) => <RowAmount>{formatMoney(row.statementEndingBalance, currency)}</RowAmount>,
    },
    {
      id: 'clearedBalance',
      header: ts.columns.clearedBalance,
      width: 'w-[140px]',
      render: (row) => <RowAmount>{row.clearedBalance === null ? null : formatMoney(row.clearedBalance, currency)}</RowAmount>,
    },
    {
      id: 'difference',
      header: ts.columns.difference,
      width: 'w-[140px]',
      render: (row) => <RowAmount>{row.difference === null ? null : formatMoney(row.difference, currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: ts.columns.status,
      width: 'w-[110px]',
      render: (row) => <StatusChip tone={STATUS_TONE[row.status]}>{ts.statuses[row.status]}</StatusChip>,
    },
    {
      id: 'completed',
      header: ts.columns.completed,
      width: 'w-[160px]',
      render: (row) => <RowDate>{row.completedAt ? formatDateTime(row.completedAt) : null}</RowDate>,
    },
  ];

  const renderRowMenu = (row: ReconciliationHistoryRow) => {
    const canUndo = latest?.id === row.id && can('banking:manage');
    const hasReport = row.status !== 'in_progress' && row.hasReport;
    if (row.status !== 'in_progress' && !hasReport && !canUndo) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t.common.actions.openMenu}
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
          >
            <EllipsisVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {row.status === 'in_progress' ? (
            <DropdownMenuItem onClick={() => openRow(row)}>
              <Play className="mr-0.5 h-3.5 w-3.5" />
              {ts.resume}
            </DropdownMenuItem>
          ) : null}
          {hasReport ? (
            <DropdownMenuItem onClick={() => openRow(row)}>
              <FileText className="mr-0.5 h-3.5 w-3.5" />
              {ts.viewReport}
            </DropdownMenuItem>
          ) : null}
          {canUndo ? (
            <DropdownMenuItem
              data-testid="undo-reconciliation"
              className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
              onClick={() => setUndoId(row.id)}
            >
              <Undo2 className="mr-0.5 h-3.5 w-3.5 text-red-600" />
              {ts.undo}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // Nothing reconciled yet: a line of text under the form reads better than a list's tall empty state.
  const historyLoading = history.isLoading && !!accountId;
  let historySection: ReactNode;
  if (rows.length === 0 && !historyLoading) {
    historySection = (
      <div className="space-y-1 px-6 pb-6">
        <h2 className="text-sm font-medium">{ts.historyTitle}</h2>
        <p className="text-sm text-muted-foreground">{ts.historyEmpty}</p>
      </div>
    );
  } else {
    historySection = (
      <WeldbooksEntityList<ReconciliationHistoryRow>
        items={rows}
        isLoading={historyLoading}
        columns={columns}
        onRowClick={openRow}
        getRowLabel={(row) => formatDate(row.statementDate)}
        renderRowMenu={renderRowMenu}
        leftActionButtons={<h2 className="text-sm font-medium">{ts.historyTitle}</h2>}
        filters={statusFilters}
        applyFilters={filterByStatus}
        emptyState={{ title: ts.historyEmpty, description: '' }}
        noResultsState={{ title: t.common.empty.noResults, description: '' }}
      />
    );
  }

  return (
    <div>
      <div className="max-w-6xl space-y-4 p-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild aria-label={ts.back}>
            <Link to="/weldbooks/banking/reconciliation">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{ts.title}</h1>
            <p className="text-sm text-muted-foreground">{ts.subtitle}</p>
          </div>
        </div>

        <div className="max-w-md space-y-1">
          <Label htmlFor="statement-account">{ts.bankAccount}</Label>
          <Select
            value={accountId}
            onValueChange={(value) => {
              setAccountId(value);
              setShowProblems(false);
              start.reset();
            }}
            disabled={accountsLoading}
          >
            <SelectTrigger id="statement-account" data-testid="statement-account">
              <SelectValue placeholder={ts.selectAccount} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {accountLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {startSection}

        {undo.isError ? <p className="text-sm text-destructive" role="alert">{(undo.error as Error).message}</p> : null}
      </div>

      {historySection}

      <ConfirmDialog
        open={undoId !== null}
        onOpenChange={(openState) => {
          if (!openState) setUndoId(null);
        }}
        title={ts.undoTitle}
        description={ts.undoDescription}
        confirmLabel={ts.undo}
        cancelLabel={ts.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!undoId) return;
          try {
            await undo.mutateAsync(undoId);
          } catch {
            // The error is shown on the page; close the dialog so it is visible.
          }
          setUndoId(null);
        }}
      />
      <ConfirmDialog
        open={discardId !== null}
        onOpenChange={(openState) => {
          if (!openState) setDiscardId(null);
        }}
        title={ts.discardTitle}
        description={ts.discardDescription}
        confirmLabel={ts.discard}
        cancelLabel={ts.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!discardId) return;
          try {
            await discard.mutateAsync(discardId);
          } catch {
            // The open reconciliation stays in the list, so there is nothing else to do.
          }
          setDiscardId(null);
        }}
      />
    </div>
  );
}
