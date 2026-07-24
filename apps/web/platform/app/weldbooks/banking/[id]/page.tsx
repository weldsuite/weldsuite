import { useMemo, useState } from 'react';
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
} from 'lucide-react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import {
  useAccountingBankAccount,
  useAccountingBankTransactions,
  useAutoReconcile,
  useDeleteBankAccount,
} from '@/hooks/queries/use-accounting-queries';
import { BankAccountFormDialog } from '@/components/accounting/bank-account-form-dialog';
import { BankTransactionsTable } from '@/components/accounting/bank-transactions-table';
import type { BankAccount, BankTransaction } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

function formatBalance(value: string | null | undefined, currency: string | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(Number(value ?? 0));
}

function formatDate(value: string | null | undefined, never: string): string {
  if (!value) return never;
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

// STATUS_OPTIONS built inside component to use translations

export default function BankAccountDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;

  const STATUS_OPTIONS = [
    { value: 'all', label: tbp.allTransactions },
    { value: 'unreconciled', label: tbp.unreconciledFilter },
    { value: 'reconciled', label: tbp.reconciledFilter },
    { value: 'excluded', label: tbp.excludedFilter },
  ];

  const { data: accountRes, isLoading: accountLoading } = useAccountingBankAccount(id);
  const account = accountRes?.data as BankAccount | undefined;

  const txnFilters = useMemo(
    () => ({
      bankAccountId: id,
      status: statusFilter === 'all' ? undefined : statusFilter,
      pageSize: 25,
    }),
    [id, statusFilter],
  );
  const { data: txnData, isLoading: txnLoading } = useAccountingBankTransactions(txnFilters);
  const { data: unreconciledData } = useAccountingBankTransactions({
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

  const transactions = (txnData?.data ?? []) as BankTransaction[];
  const unreconciledCount = unreconciledData?.data?.length ?? 0;
  const totalTransactions = txnData?.pagination?.totalCount ?? transactions.length;

  return (
    <div className="p-6 space-y-4">
      <Link
        to="/weldbooks/banking"
        className="text-sm text-muted-foreground hover:underline inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-4 w-4" /> {tbp.backToAccounts}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
            <Landmark className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{account.name}</h1>
            <p className="text-sm text-muted-foreground">
              {account.iban || '—'}
              {account.bankName ? ` · ${account.bankName}` : ''}
            </p>
            <div className="flex items-center gap-2 mt-1">
              {account.isDefault ? <Badge variant="secondary">{tbp.badges.default}</Badge> : null}
              {account.isActive === false ? <Badge variant="outline">{tbp.badges.inactive}</Badge> : null}
              {account.autoReconcile !== false ? (
                <Badge variant="outline">{tbp.badges.autoReconcileOn}</Badge>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Edit className="h-4 w-4 mr-1" />
            {tbp.edit}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
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
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {tbp.currentBalance}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {formatBalance(account.currentBalance, account.currency)}
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
            <p className="text-2xl font-semibold">{formatDate(account.lastImportDate, tbp.done)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar + transactions */}
      <div className="flex items-center justify-between gap-2 pt-2">
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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => autoReconcile.mutate(id)}
            disabled={autoReconcile.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${autoReconcile.isPending ? 'animate-spin' : ''}`} />
            {tbp.autoReconcile}
          </Button>
          <Link to="/weldbooks/banking/import" search={{ accountId: id }}>
            <Button size="sm">
              <Download className="h-4 w-4 mr-1" />
              {tbp.importStatement}
            </Button>
          </Link>
        </div>
      </div>

      {txnLoading ? (
        <PageLoader fullScreen={false} />
      ) : transactions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <Inbox className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {tbp.noTransactionsYet}
            </p>
            <Link to="/weldbooks/banking/import" search={{ accountId: id }}>
              <Button>
                <Download className="h-4 w-4 mr-1" />
                {tbp.importStatement}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <BankTransactionsTable
          transactions={transactions}
          currency={account.currency ?? 'EUR'}
          dense
        />
      )}

      <BankAccountFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        bankAccount={account}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tbp.deleteConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {tbp.deleteConfirmDesc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tbp.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                deleteMutation.mutate(id, {
                  onSuccess: () => {
                    window.location.href = '/weldbooks/banking';
                  },
                });
              }}
            >
              {tbp.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
