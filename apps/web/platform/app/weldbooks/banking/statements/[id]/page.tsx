import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, CheckCircle2, Loader2, Pencil, Save } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import {
  useBankReconciliation,
  useCompleteBankReconciliation,
  useSaveBankReconciliationProgress,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import type { Account } from '@/lib/api/domains/weldbooks';
import { AdjustmentDialog } from '../components/adjustment-dialog';
import { EditStatementDialog } from '../components/edit-statement-dialog';
import { LineTable } from '../components/line-table';
import { StatementSummary } from '../components/statement-summary';
import {
  computeStatementBalances,
  differenceIsZero,
  filterLines,
  sameIds,
  setAllTicked,
  tickedOnOrBefore,
  type ClearedFilter,
} from '../reconciliation-math';

export default function StatementWorksheetPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t } = useI18n();
  const tw = t.weldbooksUs.banking.worksheet;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate, entityCurrency } = useWeldbooksFormat();

  const { data: view, isLoading, isError } = useBankReconciliation(id);
  const { data: accountsRes } = useAccountingAccounts();
  const ledgerAccounts = useMemo(() => (accountsRes?.data ?? []) as Account[], [accountsRes]);
  const save = useSaveBankReconciliationProgress();
  const complete = useCompleteBankReconciliation();

  // The ticks being edited; null until the saved ones have loaded.
  const [cleared, setCleared] = useState<ReadonlySet<string> | null>(null);
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<ClearedFilter>('all');
  const [editOpen, setEditOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  useEffect(() => {
    if (view && cleared === null) setCleared(new Set(view.clearedLineIds));
  }, [view, cleared]);

  const inflows = useMemo(() => view?.inflows ?? [], [view]);
  const outflows = useMemo(() => view?.outflows ?? [], [view]);
  // Only lines still on the worksheet count: a changed statement date can drop some.
  const ticked = useMemo(() => {
    const valid = new Set([...inflows, ...outflows].map((l) => l.id));
    return new Set([...(cleared ?? [])].filter((lineId) => valid.has(lineId)));
  }, [cleared, inflows, outflows]);
  const saved = useMemo(() => new Set(view?.clearedLineIds ?? []), [view]);
  const dirty = !sameIds(ticked, saved);

  const balances = useMemo(
    () =>
      view
        ? computeStatementBalances({
            beginningBalance: Number(view.beginningBalance),
            statementEndingBalance: Number(view.statementEndingBalance),
            accountKind: view.accountKind,
            inflows,
            outflows,
            clearedIds: ticked,
          })
        : null,
    [view, inflows, outflows, ticked],
  );

  // Leaving with unsaved ticks asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const toggle = useCallback(
    (lineId: string, on: boolean) => setCleared((current) => setAllTicked(current ?? new Set(), [{ id: lineId }], on)),
    [],
  );
  const toggleAll = useCallback(
    (lines: readonly { id: string }[], on: boolean) => setCleared((current) => setAllTicked(current ?? new Set(), lines, on)),
    [],
  );

  if (isLoading || (view && cleared === null)) return <PageLoader fullScreen={false} />;

  if (isError || !view || !balances) {
    return (
      <div className="p-6">
        <Link to="/weldbooks/banking/statements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> {tw.back}
        </Link>
        <p className="mt-4">{tw.notFound}</p>
      </div>
    );
  }

  const card = view.accountKind === 'credit_card';
  const currency = entityCurrency;
  const money = (amount: number) => formatMoney(amount, currency);
  const inProgress = view.status === 'in_progress';
  const canEdit = inProgress && can('banking:update');
  const zero = differenceIsZero(balances);
  const visibleInflows = filterLines(inflows, { query, show, clearedIds: ticked });
  const visibleOutflows = filterLines(outflows, { query, show, clearedIds: ticked });

  const saveProgress = () => save.mutate({ id, data: { clearedLineIds: [...ticked] } });
  const finish = () =>
    complete.mutate(
      { id, data: { clearedLineIds: [...ticked] } },
      { onSuccess: () => navigate({ to: '/weldbooks/banking/statements/$id/report', params: { id } }) },
    );
  const finishWithAdjustment = (adjustment: { accountId: string; memo?: string }) =>
    complete.mutate(
      { id, data: { clearedLineIds: [...ticked], adjustment } },
      {
        onSuccess: () => {
          setAdjustOpen(false);
          navigate({ to: '/weldbooks/banking/statements/$id/report', params: { id } });
        },
      },
    );
  const saveStatement = (values: { statementDate: string; statementEndingBalance: number }) =>
    save.mutate(
      {
        id,
        data: {
          ...values,
          // Lines dated after a statement date moved back can't stay ticked.
          clearedLineIds: tickedOnOrBefore([...inflows, ...outflows], ticked, values.statementDate),
        },
      },
      {
        onSuccess: (updated) => {
          setCleared(new Set(updated.clearedLineIds));
          setEditOpen(false);
        },
      },
    );

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-4 p-6">
        <Link to="/weldbooks/banking/statements" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> {tw.back}
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              {tw.title.replace('{account}', view.bankAccountName ?? '')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {tw.statementOf.replace('{date}', formatDate(view.statementDate))}
              {view.nettedLineCount > 0 ? ` · ${tw.nettedLines.replace('{count}', String(view.nettedLineCount))}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!inProgress ? <Badge variant="outline">{tw.statuses[view.status]}</Badge> : null}
            {canEdit ? (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} data-testid="edit-statement">
                <Pencil className="h-4 w-4" />
                {tw.editStatement.title}
              </Button>
            ) : null}
          </div>
        </div>

        {inProgress ? null : (
          <div className="rounded-md border bg-muted/30 p-4 text-sm">
            <p>{tw.notEditable}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link to="/weldbooks/banking/statements/$id/report" params={{ id }}>{tw.viewReport}</Link>
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-64"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tw.searchPlaceholder}
            aria-label={tw.searchPlaceholder}
            data-testid="worksheet-search"
          />
          <Select value={show} onValueChange={(value) => setShow(value as ClearedFilter)}>
            <SelectTrigger className="w-44" aria-label={tw.filter.label} data-testid="worksheet-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tw.filter.all}</SelectItem>
              <SelectItem value="cleared">{tw.filter.cleared}</SelectItem>
              <SelectItem value="uncleared">{tw.filter.uncleared}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <LineTable
            testId="inflows"
            title={card ? tw.inflowsCard : tw.inflows}
            lines={visibleInflows}
            totalCount={inflows.length}
            ticked={ticked}
            tickedTotal={balances.clearedInflows.total}
            formatAmount={money}
            formatDate={formatDate}
            readOnly={!canEdit}
            onToggle={toggle}
            onToggleAll={toggleAll}
          />
          <LineTable
            testId="outflows"
            title={card ? tw.outflowsCard : tw.outflows}
            lines={visibleOutflows}
            totalCount={outflows.length}
            ticked={ticked}
            tickedTotal={balances.clearedOutflows.total}
            formatAmount={money}
            formatDate={formatDate}
            readOnly={!canEdit}
            onToggle={toggle}
            onToggleAll={toggleAll}
          />
        </div>
      </div>

      {inProgress ? (
        <footer className="sticky bottom-0 z-10 space-y-2 border-t bg-background/95 px-6 py-3 backdrop-blur" data-testid="worksheet-footer">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <StatementSummary balances={balances} accountKind={view.accountKind} formatAmount={money} />
            <div className="flex flex-wrap items-center gap-2">
              {dirty ? <span className="text-xs text-muted-foreground">{tw.unsaved}</span> : null}
              <Button variant="outline" onClick={saveProgress} disabled={!dirty || save.isPending || !canEdit} data-testid="save-progress">
                {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                {tw.saveProgress}
              </Button>
              {zero ? null : (
                <Button variant="outline" onClick={() => setAdjustOpen(true)} disabled={!canEdit} data-testid="post-adjustment">
                  {tw.postAdjustment}
                </Button>
              )}
              <Button onClick={finish} disabled={!zero || complete.isPending || !canEdit} data-testid="finish-reconciliation">
                {complete.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                {tw.finish}
              </Button>
            </div>
          </div>
          {zero ? null : <p className="text-xs text-muted-foreground">{tw.finishNeedsZero}</p>}
          {save.isError ? <p className="text-sm text-destructive" role="alert">{(save.error as Error).message}</p> : null}
          {complete.isError && !adjustOpen ? (
            <p className="text-sm text-destructive" role="alert">{(complete.error as Error).message}</p>
          ) : null}
        </footer>
      ) : null}

      <EditStatementDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        statementDate={view.statementDate}
        endingBalance={Number(view.statementEndingBalance)}
        accountKind={view.accountKind}
        pending={save.isPending}
        errorMessage={save.isError ? (save.error as Error).message : null}
        onSave={saveStatement}
      />
      <AdjustmentDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        difference={balances.difference}
        accounts={ledgerAccounts}
        formatAmount={money}
        accountKind={view.accountKind}
        pending={complete.isPending}
        errorMessage={complete.isError ? (complete.error as Error).message : null}
        onConfirm={finishWithAdjustment}
      />
    </div>
  );
}
