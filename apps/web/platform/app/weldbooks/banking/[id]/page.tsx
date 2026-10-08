import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import {
  Landmark,
  Edit,
  Trash2,
  Download,
  RefreshCw,
  MoreVertical,
  ArrowLeft,
  Inbox,
  Plus,
  ClipboardCheck,
  Wallet,
} from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useAutoReconcile,
  useDeleteBankAccount,
} from '@/hooks/queries/use-accounting-queries';
import { useBankAccount, useBankLines } from '@/hooks/queries/use-weldbooks-banking-queries';
import { BankTransactionFormDialog } from '@/components/accounting/bank-transaction-form-dialog';
import { BankTransactionsTable } from '@/components/accounting/bank-transactions-table';
import { isLiabilityAccountType } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { BankFeedsPanel } from '../feeds/bank-feeds-panel';
import { BankAccountFormDialog } from '../components/bank-account-form-dialog';
import { RevealAccountNumber } from '../components/reveal-account-number';

// STATUS_OPTIONS built inside component to use translations

function DetailRow({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

export default function BankAccountDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { t } = useI18n();
  const { currency: entityCurrency, formatMoney, formatDateTime } = useWeldbooksFormat();
  const tbp = t.accounting.bankingPages;
  const tb = t.weldbooksUs.banking;
  const { can } = usePermissions();
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(jurisdictionCode);

  const STATUS_OPTIONS = [
    { value: 'all', label: tbp.allTransactions },
    { value: 'unreconciled', label: tbp.unreconciledFilter },
    { value: 'reconciled', label: tbp.reconciledFilter },
    { value: 'excluded', label: tbp.excludedFilter },
  ];

  const { data: accountRes, isLoading: accountLoading } = useBankAccount(id);
  const account = accountRes?.data;

  const txnFilters = useMemo(
    () => ({
      bankAccountId: id,
      status: statusFilter === 'all' ? undefined : statusFilter,
      pageSize: 25,
    }),
    [id, statusFilter],
  );
  const { data: txnData, isLoading: txnLoading } = useBankLines(txnFilters);
  const { data: unreconciledData } = useBankLines({
    bankAccountId: id,
    status: 'unreconciled',
    pageSize: 1,
  });

  const autoReconcile = useAutoReconcile();
  const deleteMutation = useDeleteBankAccount();

  if (accountLoading) return <PageLoader fullScreen={false} />;

  if (!account) {
    return (
      <div className="p-6">
        <Link to="/weldbooks/banking" className="text-sm text-muted-foreground hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> {tbp.backToAccounts}
        </Link>
        <p className="mt-4">{tbp.bankAccountNotFound}</p>
      </div>
    );
  }

  const transactions = txnData?.data ?? [];
  const unreconciledCount = unreconciledData?.pagination?.totalCount ?? 0;
  const totalTransactions = txnData?.pagination?.totalCount ?? transactions.length;
  const liability = isLiabilityAccountType(account.accountType);
  const typeLabel = account.accountType ? tb.accountTypes[account.accountType] : null;

  let transactionsSection: ReactNode;
  if (txnLoading) {
    transactionsSection = <PageLoader fullScreen={false} />;
  } else if (transactions.length === 0) {
    transactionsSection = (
      <Card>
        <CardContent className="py-10 text-center space-y-3">
          <Inbox className="h-10 w-10 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {tbp.noTransactionsYet}
          </p>
          <div className="flex items-center justify-center gap-2">
            {can('banking:create') ? (
              <Button variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                {tbp.addTransactionButton}
              </Button>
            ) : null}
            <Link to="/weldbooks/banking/import" search={{ accountId: id }}>
              <Button>
                <Download className="h-4 w-4 mr-1" />
                {tbp.importStatement}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  } else {
    transactionsSection = (
      <BankTransactionsTable
        transactions={transactions}
        currency={account.currency ?? entityCurrency}
        dense
      />
    );
  }

  return (
    <div className="p-6 space-y-4">
      <Link
        to="/weldbooks/banking"
        className="text-sm text-muted-foreground hover:underline inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-4 w-4" /> {tbp.backToAccounts}
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
            <Landmark className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{account.name}</h1>
            <p className="text-sm text-muted-foreground">
              {isUs ? (typeLabel ?? '—') : account.iban || '—'}
              {account.bankName ? ` · ${account.bankName}` : ''}
            </p>
            <div className="flex items-center gap-2 mt-1">
              {account.isDefault ? <Badge variant="secondary">{tbp.badges.default}</Badge> : null}
              {account.isActive === false ? <Badge variant="outline">{tbp.badges.inactive}</Badge> : null}
              {account.autoReconcile !== false ? (
                <Badge variant="outline">{tbp.badges.autoReconcileOn}</Badge>
              ) : null}
              {liability ? <Badge variant="outline">{tb.accountList.liability}</Badge> : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {can('banking:update') ? (
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Edit className="h-4 w-4 mr-1" />
              {tbp.edit}
            </Button>
          ) : null}
          {can('banking:delete') ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={tb.accountDetails.moreActions}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {tbp.deleteBankAccount}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {liability ? tb.accountDetails.balanceOwed : tbp.currentBalance}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {formatMoney(account.currentBalance, account.currency ?? entityCurrency)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {tbp.unreconciled}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{unreconciledCount}</p>
            <p className="text-xs text-muted-foreground">
              {tbp.ofTransactions.replace('{total}', String(totalTransactions))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {tbp.lastImport}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatDateTime(account.lastImportDate, tbp.done)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Account details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{tb.accountDetails.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="bank-account-details">
            {isUs ? (
              <>
                <DetailRow label={tb.accountDetails.accountType}>{typeLabel ?? '—'}</DetailRow>
                {account.accountType !== 'credit_card' ? (
                  <DetailRow label={tb.accountDetails.routingNumber}>
                    <span className="font-mono">{account.routingNumber || '—'}</span>
                  </DetailRow>
                ) : null}
                <DetailRow label={account.accountType === 'credit_card' ? tb.accountDetails.cardNumber : tb.accountDetails.accountNumber}>
                  {account.hasAccountNumber ? (
                    <RevealAccountNumber bankAccountId={account.id} last4={account.accountNumberLast4} />
                  ) : (
                    <span className="text-muted-foreground">{tb.accountDetails.notSet}</span>
                  )}
                </DetailRow>
                {account.accountType !== 'credit_card' ? (
                  <DetailRow label={tb.accountDetails.nextCheckNumber}>
                    <span className="tabular-nums">{account.nextCheckNumber ?? '—'}</span>
                  </DetailRow>
                ) : null}
              </>
            ) : (
              <>
                <DetailRow label={tb.accountDetails.iban}>
                  <span className="font-mono">{account.iban || '—'}</span>
                </DetailRow>
                <DetailRow label={tb.accountDetails.bic}>
                  <span className="font-mono">{account.bic || '—'}</span>
                </DetailRow>
              </>
            )}
            <DetailRow label={tb.accountDetails.accountHolder}>{account.accountHolderName || '—'}</DetailRow>
            <DetailRow label={tb.accountDetails.currency}>{account.currency ?? entityCurrency ?? '—'}</DetailRow>
          </dl>
        </CardContent>
      </Card>

      <BankFeedsPanel bankAccountId={id} />

      {/* Toolbar + transactions */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => autoReconcile.mutate(id)}
            disabled={autoReconcile.isPending || !can('banking:update')}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${autoReconcile.isPending ? 'animate-spin' : ''}`} />
            {tbp.autoReconcile}
          </Button>
          {isUs ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link to="/weldbooks/banking/statements" search={{ accountId: id }} data-testid="reconcile-statement">
                  <ClipboardCheck className="h-4 w-4" />
                  {tb.accountList.reconcileStatement}
                </Link>
              </Button>
              {!liability && can('banking:create') ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/weldbooks/deposits/new" search={{ accountId: id }}>
                    <Wallet className="h-4 w-4" />
                    {tb.accountList.makeDeposit}
                  </Link>
                </Button>
              ) : null}
            </>
          ) : null}
          {can('banking:create') ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="add-bank-transaction"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-4 w-4 mr-1" />
              {tbp.addTransactionButton}
            </Button>
          ) : null}
          <Link to="/weldbooks/banking/import" search={{ accountId: id }}>
            <Button size="sm">
              <Download className="h-4 w-4 mr-1" />
              {tbp.importStatement}
            </Button>
          </Link>
        </div>
      </div>

      {transactionsSection}

      <BankTransactionFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        bankAccountId={id}
      />

      <BankAccountFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        bankAccount={account}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tbp.deleteConfirmTitle}
        description={tbp.deleteConfirmDesc}
        confirmLabel={tbp.delete}
        cancelLabel={tbp.cancel}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={() =>
          deleteMutation.mutate(id, {
            onSuccess: () => {
              window.location.href = '/weldbooks/banking';
            },
          })
        }
      />
    </div>
  );
}
