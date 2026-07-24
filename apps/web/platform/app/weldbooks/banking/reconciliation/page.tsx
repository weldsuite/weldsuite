import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
import { ArrowLeft, CheckCircle2, XCircle, Link2 } from 'lucide-react';
import {
  useAccountingBankAccounts,
  useAccountingBankTransactions,
} from '@/hooks/queries/use-accounting-queries';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

function fmt(value: string | number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value ?? 0));
}

interface TransactionSuggestion {
  type: string;
  entityId: string;
  entityNumber?: string | null;
  contactName?: string | null;
  amount: string | number;
  confidence: number;
  reason?: string | null;
}

export default function BankReconciliationPage() {
  const navigate = useNavigate();
  const { data: bankAccountsData } = useAccountingBankAccounts();
  const bankAccounts = bankAccountsData?.data ?? [];
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedTxnId, setSelectedTxnId] = useState<string | null>(null);
  const qc = useQueryClient();
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;
  const tsl = t.accounting.statusLabels;

  const { data: txnData, isLoading } = useAccountingBankTransactions(
    selectedAccountId ? { bankAccountId: selectedAccountId, status: 'unreconciled' } : undefined
  );
  const transactions = txnData?.data ?? [];

  // Fetch suggestions for selected transaction
  const { data: suggestionsData } = useQuery({
    queryKey: ['accounting', 'bank-transactions', 'suggestions', selectedTxnId],
    queryFn: () => accountingApi.getTransactionSuggestions(selectedTxnId!),
    enabled: !!selectedTxnId,
  });
  const suggestions = (suggestionsData?.data ?? []) as TransactionSuggestion[];

  const reconcileMutation = useMutation({
    mutationFn: ({ txnId, data }: { txnId: string; data: Record<string, unknown> }) =>
      accountingApi.reconcileTransaction(txnId, data),
    onSuccess: () => {
      setSelectedTxnId(null);
      qc.invalidateQueries({ queryKey: ['accounting', 'bank-transactions'] });
    },
  });

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

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/banking' })}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-semibold">{tbp.reconciliationTitle}</h1>
        </div>
        {selectedAccountId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => autoReconcileMutation.mutate()}
            disabled={autoReconcileMutation.isPending}
          >
            {autoReconcileMutation.isPending ? tbp.running : tbp.autoReconcileAll}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <Select value={selectedAccountId} onValueChange={(v) => { setSelectedAccountId(v); setSelectedTxnId(null); }}>
          <SelectTrigger className="w-80">
            <SelectValue placeholder={tbp.selectBankAccount} />
          </SelectTrigger>
          <SelectContent>
            {bankAccounts.map((ba) => (
              <SelectItem key={ba.id} value={ba.id}>
                {ba.name} — {ba.iban}
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
              {isLoading ? (
                <div className="p-4"><PageLoader fullScreen={false} /></div>
              ) : transactions.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{tbp.allReconciled}</p>
              ) : (
                <div className="max-h-[60vh] overflow-y-auto">
                  {transactions.map((txn) => (
                    <div
                      key={txn.id}
                      className={`p-3 border-b cursor-pointer hover:bg-muted/50 ${
                        selectedTxnId === txn.id ? 'bg-muted' : ''
                      }`}
                      onClick={() => setSelectedTxnId(txn.id)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{txn.counterpartyName || tsl.counterpartyUnknown}</span>
                        <span className={`text-sm font-semibold ${Number(txn.amount) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {fmt(txn.amount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {txn.description}
                        </span>
                        <span className="text-xs text-muted-foreground">{txn.date?.slice(0, 10)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
              ) : suggestions.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{tbp.noMatchesFound}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => excludeMutation.mutate(selectedTxnId)}
                    disabled={excludeMutation.isPending}
                  >
                    <XCircle className="h-4 w-4 mr-1" />
                    {tbp.excludeTransaction}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {suggestions.map((s, i: number) => (
                    <div key={i} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium">{s.entityNumber || s.entityId}</span>
                          {s.contactName && (
                            <span className="text-xs text-muted-foreground ml-2">({s.contactName})</span>
                          )}
                        </div>
                        <Badge variant={s.type === 'invoice' ? 'default' : 'secondary'} className="capitalize">
                          {s.type}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span>{tbp.amount.replace('{amount}', fmt(s.amount))}</span>
                        <span className="text-muted-foreground">
                          {tbp.confidence.replace('{percent}', String(Math.round(s.confidence * 100)))}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{s.reason}</p>
                      <Button
                        size="sm"
                        onClick={() =>
                          reconcileMutation.mutate({
                            txnId: selectedTxnId,
                            data: {
                              type: s.type,
                              entityId: s.entityId,
                            },
                          })
                        }
                        disabled={reconcileMutation.isPending}
                      >
                        <Link2 className="h-4 w-4 mr-1" />
                        {tbp.reconcile}
                      </Button>
                    </div>
                  ))}
                  <div className="border-t pt-3 mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => excludeMutation.mutate(selectedTxnId)}
                      disabled={excludeMutation.isPending}
                    >
                      <XCircle className="h-4 w-4 mr-1" />
                      {tbp.excludeTransaction}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
