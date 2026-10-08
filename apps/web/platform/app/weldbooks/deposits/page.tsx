import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, Wallet } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useBankAccounts, useBankDeposits } from '@/hooks/queries/use-weldbooks-banking-queries';
import { UndepositedFundsCallout } from '../banking/components/undeposited-funds-callout';

const PAGE_SIZE = 25;

export default function DepositsPage() {
  const { t } = useI18n();
  const td = t.weldbooksUs.banking.deposits;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate, entityCurrency } = useWeldbooksFormat();

  const [bankAccountId, setBankAccountId] = useState('all');
  const [status, setStatus] = useState<'all' | 'posted' | 'void'>('all');
  // Cursor pagination: the cursor of every page already visited, newest last.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);

  const { data: accountsRes } = useBankAccounts();
  const accountNames = useMemo(
    () => new Map((accountsRes?.data ?? []).map((a) => [a.id, a.name])),
    [accountsRes],
  );

  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      bankAccountId: bankAccountId === 'all' ? undefined : bankAccountId,
      status: status === 'all' ? undefined : status,
      cursor,
    }),
    [bankAccountId, status, cursor],
  );
  const { data, isLoading, isError } = useBankDeposits(filters);
  const deposits = data?.data ?? [];

  const resetPaging = () => setCursors([]);

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = <p className="text-sm text-destructive" role="alert">{td.loadFailed}</p>;
  } else if (deposits.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Wallet className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="font-medium">{td.emptyTitle}</p>
          <p className="text-sm text-muted-foreground">{td.emptyDescription}</p>
          {can('banking:create') ? (
            <Button asChild>
              <Link to="/weldbooks/deposits/new">{td.makeDeposit}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{td.columns.date}</TableHead>
                <TableHead>{td.columns.bankAccount}</TableHead>
                <TableHead>{td.columns.memo}</TableHead>
                <TableHead>{td.columns.status}</TableHead>
                <TableHead>{td.columns.bankLine}</TableHead>
                <TableHead className="text-right">{td.columns.amount}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deposits.map((deposit) => (
                <TableRow
                  key={deposit.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => navigate({ to: '/weldbooks/deposits/$id', params: { id: deposit.id } })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') navigate({ to: '/weldbooks/deposits/$id', params: { id: deposit.id } });
                  }}
                >
                  <TableCell className="whitespace-nowrap">{formatDate(deposit.date)}</TableCell>
                  <TableCell>{accountNames.get(deposit.bankAccountId) ?? '—'}</TableCell>
                  <TableCell className="max-w-[320px] truncate text-muted-foreground">{deposit.memo || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={deposit.status === 'void' ? 'outline' : 'success'}>{td.statuses[deposit.status]}</Badge>
                  </TableCell>
                  <TableCell>
                    {deposit.bankTransactionId ? (
                      <Badge variant="secondary">{td.matched}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatMoney(deposit.amount, deposit.currency || entityCurrency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{td.count.replace('{count}', String(data?.pagination.totalCount ?? deposits.length))}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              {td.newer}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.pagination.hasMore || !data.pagination.cursor}
              onClick={() => {
                const next = data?.pagination.cursor;
                if (next) setCursors((c) => [...c, next]);
              }}
            >
              {td.older}
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{td.title}</h1>
          <p className="text-sm text-muted-foreground">{td.subtitle}</p>
        </div>
        {can('banking:create') ? (
          <Button asChild>
            <Link to="/weldbooks/deposits/new">
              <Plus className="h-4 w-4" />
              {td.makeDeposit}
            </Link>
          </Button>
        ) : null}
      </div>

      <UndepositedFundsCallout />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label className="text-xs text-muted-foreground" htmlFor="deposit-filter-account">{td.columns.bankAccount}</label>
          <Select
            value={bankAccountId}
            onValueChange={(value) => {
              setBankAccountId(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="deposit-filter-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{td.allAccounts}</SelectItem>
              {(accountsRes?.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <label className="text-xs text-muted-foreground" htmlFor="deposit-filter-status">{td.columns.status}</label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as 'all' | 'posted' | 'void');
              resetPaging();
            }}
          >
            <SelectTrigger id="deposit-filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{td.allStatuses}</SelectItem>
              <SelectItem value="posted">{td.statuses.posted}</SelectItem>
              <SelectItem value="void">{td.statuses.void}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {body}
    </div>
  );
}
