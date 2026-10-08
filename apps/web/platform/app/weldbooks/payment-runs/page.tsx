import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, ReceiptText } from 'lucide-react';
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
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { usePaymentRuns } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import { RUN_METHODS, RUN_STATUSES, type RunMethod, type RunStatus } from '@/lib/api/domains/weldbooks-payment-runs';
import { PaymentRunsFrame } from './components/payment-runs-frame';
import { RunMethodBadge, RunStatusBadge } from './components/run-badges';

const PAGE_SIZE = 25;
const ALL = 'all';

export default function PaymentRunsPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tl = tp.list;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const [status, setStatus] = useState<RunStatus | typeof ALL>(ALL);
  const [method, setMethod] = useState<RunMethod | typeof ALL>(ALL);
  const [bankAccountId, setBankAccountId] = useState<string>(ALL);
  // Cursor pagination: the cursor of every page already visited, newest last.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);

  const { data: accountsRes } = useBankAccounts();
  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      status: status === ALL ? undefined : status,
      method: method === ALL ? undefined : method,
      bankAccountId: bankAccountId === ALL ? undefined : bankAccountId,
      cursor,
    }),
    [status, method, bankAccountId, cursor],
  );
  const { data, isLoading, isError, refetch } = usePaymentRuns(filters);
  const runs = data?.data ?? [];
  const canCreate = can('banking:create');

  const resetPaging = () => setCursors([]);
  const open = (id: string) => navigate({ to: '/weldbooks/payment-runs/$id', params: { id } });

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-destructive" role="alert">{tp.common.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>{tp.common.retry}</Button>
      </div>
    );
  } else if (runs.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <ReceiptText className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="font-medium">{tl.emptyTitle}</p>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{tl.emptyDescription}</p>
          {canCreate ? (
            <Button asChild>
              <Link to="/weldbooks/payment-runs/new">{tl.newRun}</Link>
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
                <TableHead>{tl.columns.paymentDate}</TableHead>
                <TableHead>{tl.columns.method}</TableHead>
                <TableHead>{tl.columns.bankAccount}</TableHead>
                <TableHead className="text-right">{tl.columns.bills}</TableHead>
                <TableHead className="text-right">{tl.columns.vendors}</TableHead>
                <TableHead>{tl.columns.approvals}</TableHead>
                <TableHead>{tl.columns.status}</TableHead>
                <TableHead className="text-right">{tl.columns.total}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow
                  key={run.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => open(run.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') open(run.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap">{formatDate(run.paymentDate)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <RunMethodBadge method={run.method} />
                      {run.method === 'ach' && run.sameDay ? <Badge variant="secondary">{tp.sameDay}</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>{run.bankAccountName ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.billCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.paymentCount}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {run.status === 'draft' || run.status === 'cancelled'
                      ? '—'
                      : tl.approvalsOf.replace('{done}', String(run.approvalCount)).replace('{required}', String(run.requiredApprovals))}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <RunStatusBadge status={run.status} />
                      {run.heldVendorCount > 0 ? (
                        <Badge variant="warning">{tl.heldVendors.replace('{count}', String(run.heldVendorCount))}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatMoney(run.totalAmount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{tl.count.replace('{count}', String(data?.pagination.totalCount ?? runs.length))}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              {tp.common.newer}
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
              {tp.common.older}
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <PaymentRunsFrame
      title={tl.title}
      subtitle={tl.subtitle}
      actions={
        canCreate ? (
          <Button asChild>
            <Link to="/weldbooks/payment-runs/new">
              <Plus className="h-4 w-4" />
              {tl.newRun}
            </Link>
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <label className="text-xs text-muted-foreground" htmlFor="run-filter-status">{tl.columns.status}</label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as RunStatus | typeof ALL);
              resetPaging();
            }}
          >
            <SelectTrigger id="run-filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tl.allStatuses}</SelectItem>
              {RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{tp.statuses[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-40">
          <label className="text-xs text-muted-foreground" htmlFor="run-filter-method">{tl.columns.method}</label>
          <Select
            value={method}
            onValueChange={(value) => {
              setMethod(value as RunMethod | typeof ALL);
              resetPaging();
            }}
          >
            <SelectTrigger id="run-filter-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tl.allMethods}</SelectItem>
              {RUN_METHODS.map((m) => (
                <SelectItem key={m} value={m}>{tp.methods[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-56">
          <label className="text-xs text-muted-foreground" htmlFor="run-filter-account">{tl.columns.bankAccount}</label>
          <Select
            value={bankAccountId}
            onValueChange={(value) => {
              setBankAccountId(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="run-filter-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tl.allAccounts}</SelectItem>
              {(accountsRes?.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {body}
    </PaymentRunsFrame>
  );
}
