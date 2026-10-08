import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
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
import type { MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { CategorizeBankTransactionPanel } from '@/components/accounting/categorize-bank-transaction-panel';
import { SuggestionList } from '../components/suggestion-list';
import { maskedAccountNumber } from '../components/routing-number';

export default function BankReconciliationPage() {
  const navigate = useNavigate();
  const { data: bankAccountsData } = useBankAccounts();
  const bankAccounts = bankAccountsData?.data ?? [];
  const [selectedAccountId, setSelectedAccountId] = useState('');
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
          <div
            key={txn.id}
            role="button"
            tabIndex={0}
            className={`p-3 border-b cursor-pointer hover:bg-muted/50 ${
              selectedTxnId === txn.id ? 'bg-muted' : ''
            }`}
            onClick={() => setSelectedTxnId(txn.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSelectedTxnId(txn.id);
              }
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{txn.counterpartyName || tsl.counterpartyUnknown}</span>
              <span className={`text-sm font-semibold ${Number(txn.amount) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {fmt(txn.amount, displayCurrency)}
              </span>
            </div>
            <div className="flex items-center justify-between mt-1 gap-2">
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                {txn.description}
              </span>
              <span className="text-xs text-muted-foreground">{formatDate(txn.date)}</span>
            </div>
            {txn.checkNumber || txn.source ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {txn.checkNumber ? (
                  <Badge variant="outline">{tl.checkNumberBadge.replace('{number}', txn.checkNumber)}</Badge>
                ) : null}
                {txn.source ? <Badge variant="secondary">{tl.sources[txn.source]}</Badge> : null}
              </div>
            ) : null}
          </div>
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
          {tbp.autoReconciledCount.replace('{count}', String(autoReconcileMutation.data?.data?.reconciledCount ?? 0))}
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
