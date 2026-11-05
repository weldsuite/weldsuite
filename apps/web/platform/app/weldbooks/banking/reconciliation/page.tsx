import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ArrowLeft, CheckCircle2, ClipboardCheck, XCircle } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import {
  useBankAccounts,
  useBankLines,
  useBankLineSuggestions,
  useMatchBankLineToDeposit,
  useMatchBankLineToPayment,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi, type Account } from '@/lib/api/domains/weldbooks';
import type { BankLine, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { CategorizeBankTransactionPanel } from '@/components/accounting/categorize-bank-transaction-panel';
import { SuggestionList } from '../components/suggestion-list';
import { maskedAccountNumber } from '../components/routing-number';

/** "2 of 5 reconciled", or just the count when the server didn't send the lines it tried. */
function autoReconcileSummary(
  tbp: { autoReconciledOfTotal: string; autoReconciledCount: string },
  result: { reconciledCount?: number; results?: unknown[] } | undefined,
): string {
  const count = String(result?.reconciledCount ?? 0);
  return result?.results
    ? tbp.autoReconciledOfTotal.replace('{count}', count).replace('{total}', String(result.results.length))
    : tbp.autoReconciledCount.replace('{count}', count);
}

/** One unreconciled line in the list; the selected one is marked. */
function ReconcileLineButton({
  txn,
  selected,
  unknownLabel,
  amountLabel,
  dateLabel,
  checkNumberLabel,
  sourceLabel,
  onSelect,
}: {
  txn: BankLine;
  selected: boolean;
  unknownLabel: string;
  amountLabel: string;
  dateLabel: string;
  checkNumberLabel: string | null;
  sourceLabel: string | null;
  onSelect: () => void;
}) {
  // Without a counterparty the description is what tells lines apart.
  const title = txn.counterpartyName || txn.description || unknownLabel;
  const subtitle = txn.counterpartyName ? txn.description : null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`reconcile-line-${txn.id}`}
      className={`block w-full text-left p-3 border-b border-l-4 cursor-pointer ${
        selected ? 'border-l-primary bg-primary/10' : 'border-l-transparent hover:bg-muted/50'
      }`}
      onClick={onSelect}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        <span className={`text-sm font-semibold ${Number(txn.amount) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          {amountLabel}
        </span>
      </span>
      <span className="flex items-center justify-between mt-1 gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{subtitle}</span>
        <span className="shrink-0 text-xs tabular-nums">{dateLabel}</span>
      </span>
      {checkNumberLabel || sourceLabel ? (
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {checkNumberLabel ? <Badge variant="outline">{checkNumberLabel}</Badge> : null}
          {sourceLabel ? <Badge variant="secondary">{sourceLabel}</Badge> : null}
        </span>
      ) : null}
    </button>
  );
}

export default function BankReconciliationPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { accountId?: string };
  const { data: bankAccountsData } = useBankAccounts();
  const bankAccounts = bankAccountsData?.data ?? [];
  const [selectedAccountId, setSelectedAccountId] = useState(search.accountId ?? '');

  // Nothing to choose with a single bank account.
  const onlyAccountId = bankAccounts.length === 1 ? bankAccounts[0].id : '';
  useEffect(() => {
    if (!selectedAccountId && onlyAccountId) setSelectedAccountId(onlyAccountId);
  }, [selectedAccountId, onlyAccountId]);
  const [selectedTxnId, setSelectedTxnId] = useState<string | null>(null);
  const qc = useQueryClient();
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;
  const tsl = t.accounting.statusLabels;
  const tl = t.weldbooksUs.banking.lines;
  const tr = t.weldbooksUs.banking.reconciliationPage;
  const { can } = usePermissions();
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(jurisdictionCode);
  const { formatMoney: fmt, formatDate, currency: entityCurrency } = useWeldbooksFormat();

  const { data: txnData, isLoading } = useBankLines(
    selectedAccountId ? { bankAccountId: selectedAccountId, status: 'unreconciled' } : undefined,
  );
  const { data: accountsData } = useAccountingAccounts();
  const ledgerAccounts = (accountsData?.data ?? []) as Account[];
  const transactions = txnData?.data ?? [];

  // Suggestions for the selected bank line
  const { data: suggestions = [] } = useBankLineSuggestions(selectedTxnId);
  const selectedAccount = bankAccounts.find((ba) => ba.id === selectedAccountId);
  const displayCurrency = selectedAccount?.currency || entityCurrency;

  const reconcileMutation = useMutation({
    mutationFn: ({ txnId, data }: { txnId: string; data: Record<string, unknown> }) =>
      accountingApi.reconcileTransaction(txnId, data),
    onSuccess: () => {
      setSelectedTxnId(null);
      qc.invalidateQueries({ queryKey: ['accounting', 'bank-transactions'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'journal-entries'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'accounts'] });
    },
  });
  const matchPayment = useMatchBankLineToPayment();
  const matchDeposit = useMatchBankLineToDeposit();

  const excludeMutation = useMutation({
    mutationFn: (txnId: string) => accountingApi.excludeTransaction(txnId),
    onSuccess: () => {
      setSelectedTxnId(null);
      qc.invalidateQueries({ queryKey: ['accounting', 'bank-transactions'] });
    },
  });

  const autoReconcileMutation = useMutation({
    mutationFn: () => accountingApi.autoReconcile(selectedAccountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting', 'bank-transactions'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'journal-entries'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'reconciliation-rules'] });
    },
  });

  const matching = reconcileMutation.isPending || matchPayment.isPending || matchDeposit.isPending;
  const matchError = (reconcileMutation.error ?? matchPayment.error ?? matchDeposit.error) as Error | null;

  const handleMatch = (s: MatchSuggestion) => {
    if (!selectedTxnId) return;
    if (s.type === 'payment') {
      matchPayment.mutate({ lineId: selectedTxnId, paymentId: s.id }, { onSuccess: () => setSelectedTxnId(null) });
    } else if (s.type === 'deposit') {
      matchDeposit.mutate({ lineId: selectedTxnId, depositId: s.id }, { onSuccess: () => setSelectedTxnId(null) });
    } else if (s.type === 'rule') {
      // The server applies the rule's account, tax rate and contact, as auto-reconcile does, and counts the match.
      reconcileMutation.mutate({ txnId: selectedTxnId, data: { type: 'manual', ruleId: s.id } });
    } else {
      reconcileMutation.mutate({ txnId: selectedTxnId, data: { type: s.type, entityId: s.id } });
    }
  };

  const accountLabel = (ba: (typeof bankAccounts)[number]) =>
    `${ba.name} — ${ba.accountNumberLast4 ? maskedAccountNumber(ba.accountNumberLast4) : (ba.iban ?? '')}`;

  let transactionList: ReactNode;
  if (isLoading) {
    transactionList = <div className="p-4"><PageLoader fullScreen={false} /></div>;
  } else if (transactions.length === 0) {
    transactionList = <p className="p-4 text-sm text-muted-foreground">{tbp.allReconciled}</p>;
  } else {
    transactionList = (
      <div className="max-h-[60vh] overflow-y-auto">
        {transactions.map((txn) => (
          <ReconcileLineButton
            key={txn.id}
            txn={txn}
            selected={selectedTxnId === txn.id}
            unknownLabel={tsl.counterpartyUnknown}
            amountLabel={fmt(txn.amount, displayCurrency)}
            dateLabel={formatDate(txn.date)}
            checkNumberLabel={txn.checkNumber ? tl.checkNumberBadge.replace('{number}', txn.checkNumber) : null}
            sourceLabel={txn.source ? tl.sources[txn.source] : null}
            onSelect={() => setSelectedTxnId(txn.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/banking' })} aria-label={tbp.backToAccounts}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-semibold">{tbp.reconciliationTitle}</h1>
        </div>
        <div className="flex items-center gap-2">
          {isUs ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/weldbooks/banking/statements" search={selectedAccountId ? { accountId: selectedAccountId } : {}}>
                <ClipboardCheck className="h-4 w-4" />
                {tr.reconcileStatement}
              </Link>
            </Button>
          ) : null}
          {selectedAccountId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => autoReconcileMutation.mutate()}
              disabled={autoReconcileMutation.isPending || !can('banking:update')}
            >
              {autoReconcileMutation.isPending ? tbp.running : tbp.autoReconcileAll}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Select value={selectedAccountId} onValueChange={(v) => { setSelectedAccountId(v); setSelectedTxnId(null); }}>
          <SelectTrigger className="w-full sm:w-96">
            <SelectValue placeholder={tbp.selectBankAccount} />
          </SelectTrigger>
          <SelectContent>
            {bankAccounts.map((ba) => (
              <SelectItem key={ba.id} value={ba.id}>
                {accountLabel(ba)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {autoReconcileMutation.isSuccess && (
        <div className="text-sm text-green-600 flex items-center gap-1">
          <CheckCircle2 className="h-4 w-4" />
          {autoReconcileSummary(tbp, autoReconcileMutation.data?.data)}
        </div>
      )}

      {selectedAccountId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left: Unreconciled transactions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tbp.unreconciledTransactions.replace('{count}', String(transactions.length))}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {transactionList}
            </CardContent>
          </Card>

          {/* Right: Match suggestions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {selectedTxnId ? tbp.matchSuggestions : tbp.selectTransaction}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selectedTxnId ? (
                <p className="text-sm text-muted-foreground">
                  {tbp.clickToSeeSuggestions}
                </p>
              ) : (
                <div className="space-y-3">
                  {suggestions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{tbp.noMatchesFound}</p>
                  ) : (
                    <SuggestionList
                      suggestions={suggestions}
                      formatAmount={(amount) => fmt(amount, displayCurrency)}
                      pending={matching}
                      readOnly={!can('banking:update')}
                      onMatch={handleMatch}
                    />
                  )}
                  {matchError ? (
                    <p className="text-sm text-destructive" role="alert" data-testid="match-error">{matchError.message}</p>
                  ) : null}
                  <CategorizeBankTransactionPanel
                    key={selectedTxnId}
                    accounts={ledgerAccounts}
                    pending={reconcileMutation.isPending}
                    errorMessage={(reconcileMutation.error as Error | null)?.message ?? null}
                    labels={{
                      title: tbp.categorizeTitle,
                      hint: tbp.categorizeHint,
                      accountLabel: tbp.categorizeAccountLabel,
                      accountPlaceholder: tbp.categorizeAccountPlaceholder,
                      button: tbp.categorizeButton,
                      examples: tbp.categorizeExamples,
                    }}
                    onCategorize={(categoryAccountId) =>
                      reconcileMutation.mutate({
                        txnId: selectedTxnId,
                        data: { type: 'manual', categoryAccountId },
                      })
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => excludeMutation.mutate(selectedTxnId)}
                    disabled={excludeMutation.isPending || !can('banking:update')}
                  >
                    <XCircle className="h-4 w-4 mr-1" />
                    {tbp.excludeTransaction}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
