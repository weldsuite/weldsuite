import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Download, Inbox } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useAccountingBankAccounts,
  useAccountingBankTransactions,
} from '@/hooks/queries/use-accounting-queries';
import { BankTransactionsTable } from '@/components/accounting/bank-transactions-table';
import type { BankAccount, BankTransaction } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

const PAGE_SIZE = 50;

export default function BankTransactionsPage() {
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;

  const STATUS_OPTIONS = [
    { value: 'all', label: tbp.allStatuses },
    { value: 'unreconciled', label: tbp.unreconciledFilter },
    { value: 'reconciled', label: tbp.reconciledFilter },
    { value: 'excluded', label: tbp.excludedFilter },
  ];

  const { data: accountsRes } = useAccountingBankAccounts();
  const accounts = (accountsRes?.data ?? []) as BankAccount[];

  const filters = useMemo(
    () => ({
      bankAccountId: accountFilter === 'all' ? undefined : accountFilter,
      status: statusFilter === 'all' ? undefined : statusFilter,
      from: from || undefined,
      to: to || undefined,
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [accountFilter, statusFilter, from, to, search, page],
  );

  const { data: txnData, isLoading } = useAccountingBankTransactions(filters);
  const transactions = (txnData?.data ?? []) as BankTransaction[];
  const total = txnData?.pagination?.totalCount ?? transactions.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const currencyForDisplay =
    accountFilter !== 'all'
      ? accounts.find((a) => a.id === accountFilter)?.currency ?? 'EUR'
      : 'EUR';

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{tbp.transactionsTitle}</h1>
          <p className="text-sm text-muted-foreground">{tbp.transactionsSubtitle}</p>
        </div>
        <Link to="/weldbooks/banking/import">
          <Button size="sm">
            <Download className="h-4 w-4 mr-1" />
            {tbp.importStatementButton}
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label className="text-xs text-muted-foreground">{tbp.accountLabel}</label>
          <Select
            value={accountFilter}
            onValueChange={(v) => {
              setAccountFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tbp.allAccounts}</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <label className="text-xs text-muted-foreground">{tbp.statusLabel}</label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <label className="text-xs text-muted-foreground">{tbp.fromLabel}</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-44">
          <label className="text-xs text-muted-foreground">{tbp.toLabel}</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-muted-foreground">{tbp.searchLabel}</label>
          <Input
            placeholder={tbp.searchPlaceholder}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {isLoading ? (
        <PageLoader fullScreen={false} />
      ) : transactions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <Inbox className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{tbp.noTransactionsMatch}</p>
            <Link to="/weldbooks/banking/import">
              <Button>
                <Download className="h-4 w-4 mr-1" />
                {tbp.importStatementButton}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <BankTransactionsTable
            transactions={transactions}
            currency={currencyForDisplay}
            groupByStatus={statusFilter === 'all'}
          />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total === 1
                ? tbp.transactionCount.replace('{count}', String(total))
                : tbp.transactionCountPlural.replace('{count}', String(total))}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                {tbp.previous}
              </Button>
              <span>
                {tbp.pageOf
                  .replace('{page}', String(page))
                  .replace('{total}', String(totalPages))}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {tbp.next_page}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
