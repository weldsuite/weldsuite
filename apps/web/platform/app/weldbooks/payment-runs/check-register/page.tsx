import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BookOpen } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
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
import { useCheckRegister } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { CheckStatus } from '@/lib/api/domains/weldbooks-payment-runs';
import { PaymentRunsFrame } from '../components/payment-runs-frame';
import { CheckStatusBadge } from '../components/run-badges';
import { VoidCheckDialog, type VoidableCheck } from '../components/void-check-dialog';

const PAGE_SIZE = 50;
const ALL = 'all';
const STATUSES: readonly CheckStatus[] = ['to_print', 'printed', 'cleared', 'voided'];

export default function CheckRegisterPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tr = tp.register;
  const { can } = usePermissions();
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();

  const [bankAccountId, setBankAccountId] = useState<string>(ALL);
  const [status, setStatus] = useState<CheckStatus | typeof ALL>(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [voiding, setVoiding] = useState<VoidableCheck | null>(null);

  const { data: accountsRes } = useBankAccounts();
  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      bankAccountId: bankAccountId === ALL ? undefined : bankAccountId,
      status: status === ALL ? undefined : status,
      from: from || undefined,
      to: to || undefined,
      cursor,
    }),
    [bankAccountId, status, from, to, cursor],
  );
  const { data, isLoading, isError, refetch } = useCheckRegister(filters, { enabled: can('banking:read') });
  const rows = data?.data ?? [];
  const canVoid = can('banking:manage');
  const accountNames = useMemo(() => new Map((accountsRes?.data ?? []).map((a) => [a.id, a.name])), [accountsRes]);

  const resetPaging = () => setCursors([]);

  let body: React.ReactNode;
  if (!can('banking:read')) {
    body = <p className="text-sm text-muted-foreground">{tp.common.noPermission}</p>;
  } else if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-destructive" role="alert">{tp.common.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>{tp.common.retry}</Button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <BookOpen className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="font-medium">{tr.emptyTitle}</p>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{tr.emptyDescription}</p>
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap gap-2 text-sm">
          {STATUSES.map((s) => {
            const summary = data?.summary[s];
            return (
              <span key={s} className="rounded-md border px-3 py-1.5">
                <span className="text-muted-foreground">{tp.checkStatuses[s]}: </span>
                <span className="font-medium tabular-nums">{summary?.count ?? 0}</span>
                {summary ? <span className="text-muted-foreground"> · {formatMoney(summary.total)}</span> : null}
              </span>
            );
          })}
        </div>

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr.columns.number}</TableHead>
                <TableHead>{tr.columns.date}</TableHead>
                <TableHead>{tr.columns.payee}</TableHead>
                <TableHead>{tr.columns.bankAccount}</TableHead>
                <TableHead>{tr.columns.status}</TableHead>
                <TableHead>{tr.columns.run}</TableHead>
                <TableHead className="text-right">{tr.columns.amount}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.paymentId} className={row.status === 'voided' ? 'text-muted-foreground' : undefined}>
                  <TableCell className="font-medium tabular-nums">{row.checkNumber}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
                  <TableCell>
                    {row.payeeName}
                    {row.status === 'voided' && row.voidedAt ? (
                      <p className="text-xs">{tr.voidedOn.replace('{date}', formatDateTime(row.voidedAt))}</p>
                    ) : null}
                    {row.notes && row.status === 'voided' ? <p className="text-xs">{row.notes.split('\n').at(-1)}</p> : null}
                  </TableCell>
                  <TableCell>{row.bankAccountId ? (accountNames.get(row.bankAccountId) ?? '—') : '—'}</TableCell>
                  <TableCell><CheckStatusBadge status={row.status} /></TableCell>
                  <TableCell>
                    {row.runId ? (
                      <Link to="/weldbooks/payment-runs/$id" params={{ id: row.runId }} className="underline underline-offset-2">
                        {tr.openRun}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.amount)}
                    {row.backupWithholdingAmount ? (
                      <p className="text-xs font-normal">
                        {tr.withholdingLine
                          .replace('{gross}', formatMoney(row.grossAmount))
                          .replace('{withheld}', formatMoney(row.backupWithholdingAmount))}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {canVoid && (row.status === 'printed' || row.status === 'to_print') ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setVoiding({
                            paymentId: row.paymentId,
                            checkNumber: row.checkNumber,
                            payeeName: row.payeeName,
                            amount: row.amount,
                            backupWithholdingAmount: row.backupWithholdingAmount,
                          })
                        }
                      >
                        {tr.voidAction}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{tr.count.replace('{count}', String(data?.pagination.totalCount ?? rows.length))}</span>
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
    <PaymentRunsFrame title={tr.title} subtitle={tr.subtitle}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <label className="text-xs text-muted-foreground" htmlFor="register-account">{tr.columns.bankAccount}</label>
          <Select
            value={bankAccountId}
            onValueChange={(value) => {
              setBankAccountId(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="register-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tp.list.allAccounts}</SelectItem>
              {(accountsRes?.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <label className="text-xs text-muted-foreground" htmlFor="register-status">{tr.columns.status}</label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as CheckStatus | typeof ALL);
              resetPaging();
            }}
          >
            <SelectTrigger id="register-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tp.list.allStatuses}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{tp.checkStatuses[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="register-from">{tr.from}</label>
          <Input
            id="register-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPaging();
            }}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="register-to">{tr.to}</label>
          <Input
            id="register-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetPaging();
            }}
          />
        </div>
      </div>

      {body}

      <VoidCheckDialog check={voiding} onOpenChange={(open) => { if (!open) setVoiding(null); }} />
    </PaymentRunsFrame>
  );
}
