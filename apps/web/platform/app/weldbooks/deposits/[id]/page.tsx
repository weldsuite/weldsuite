import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, Loader2, Wallet } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  useBankDeposit,
  useUpdateBankDepositMemo,
  useVoidBankDeposit,
} from '@/hooks/queries/use-weldbooks-banking-queries';

function Detail({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

export default function DepositDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t } = useI18n();
  const td = t.weldbooksUs.banking.deposits;
  const tdd = td.detail;
  const methodLabels = t.accounting.paymentMethods;
  const { can } = usePermissions();
  const { formatMoney, formatDate, entityCurrency } = useWeldbooksFormat();

  const { data: deposit, isLoading, isError } = useBankDeposit(id);
  const updateMemo = useUpdateBankDepositMemo();
  const voidDeposit = useVoidBankDeposit();
  const [memo, setMemo] = useState('');
  const [confirmVoid, setConfirmVoid] = useState(false);

  useEffect(() => {
    setMemo(deposit?.memo ?? '');
  }, [deposit?.memo]);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (isError || !deposit) {
    return (
      <div className="p-6">
        <Link to="/weldbooks/deposits" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> {tdd.back}
        </Link>
        <p className="mt-4">{tdd.notFound}</p>
      </div>
    );
  }

  const currency = deposit.currency || entityCurrency;
  const isVoid = deposit.status === 'void';
  const canEdit = can('banking:update') && !isVoid;
  const memoChanged = memo.trim() !== (deposit.memo ?? '');
  const paymentsTotal = deposit.payments.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0) / 100;

  return (
    <div className="space-y-4 p-6">
      <Link to="/weldbooks/deposits" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {tdd.back}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Wallet className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tabular-nums">{formatMoney(deposit.amount, currency)}</h1>
            <p className="text-sm text-muted-foreground">
              {tdd.heading
                .replace('{date}', formatDate(deposit.date))
                .replace('{account}', deposit.bankAccountName ?? '—')}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={isVoid ? 'outline' : 'success'}>{td.statuses[deposit.status]}</Badge>
              {deposit.bankTransactionId ? <Badge variant="secondary">{td.matched}</Badge> : null}
            </div>
          </div>
        </div>
        {canEdit ? (
          <Button variant="outline" onClick={() => setConfirmVoid(true)} data-testid="void-deposit">
            <Ban className="h-4 w-4" />
            {tdd.void}
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label={td.columns.date}>{formatDate(deposit.date)}</Detail>
            <Detail label={td.columns.bankAccount}>{deposit.bankAccountName ?? '—'}</Detail>
            <Detail label={tdd.journalEntry}>
              {deposit.journalEntryId ? (
                <Link to="/weldbooks/journal/$id" params={{ id: deposit.journalEntryId }} className="text-primary hover:underline">
                  {deposit.journalEntryNumber ?? deposit.journalEntryId}
                </Link>
              ) : (
                '—'
              )}
            </Detail>
            <Detail label={td.columns.bankLine}>
              {deposit.bankTransactionId ? tdd.matchedToLine : tdd.notMatched}
            </Detail>
          </dl>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-[16rem] flex-1 space-y-1">
              <Label htmlFor="deposit-detail-memo">{td.columns.memo}</Label>
              <Input
                id="deposit-detail-memo"
                value={memo}
                maxLength={500}
                disabled={!canEdit}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
            {canEdit ? (
              <Button
                variant="outline"
                disabled={!memoChanged || updateMemo.isPending}
                onClick={() => updateMemo.mutate({ id, memo: memo.trim() || null })}
              >
                {updateMemo.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {tdd.saveMemo}
              </Button>
            ) : null}
          </div>
          {updateMemo.isError ? (
            <p className="mt-2 text-sm text-destructive" role="alert">{(updateMemo.error as Error).message}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tdd.paymentsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {deposit.payments.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{tdd.noPayments}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{td.make.columns.date}</TableHead>
                    <TableHead>{td.make.columns.from}</TableHead>
                    <TableHead>{td.make.columns.method}</TableHead>
                    <TableHead>{td.make.columns.checkNumber}</TableHead>
                    <TableHead>{td.make.columns.reference}</TableHead>
                    <TableHead className="text-right">{td.make.columns.amount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deposit.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(p.date)}</TableCell>
                      <TableCell>{p.contactName ?? '—'}</TableCell>
                      <TableCell>
                        {p.paymentMethod && p.paymentMethod in methodLabels
                          ? methodLabels[p.paymentMethod as keyof typeof methodLabels]
                          : (p.paymentMethod ?? '—')}
                      </TableCell>
                      <TableCell>{p.checkNumber ?? ''}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">{p.reference ?? ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(p.amount, p.currency || currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{tdd.paymentsSubtotal}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(paymentsTotal, currency)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {deposit.otherLines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tdd.otherTitle}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{td.make.columns.account}</TableHead>
                    <TableHead>{td.make.columns.description}</TableHead>
                    <TableHead className="text-right">{td.make.columns.lineAmount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deposit.otherLines.map((line) => (
                    <TableRow key={`${line.accountId}:${line.amount}:${line.description ?? ''}`}>
                      <TableCell>
                        {line.accountCode ? `${line.accountCode} — ${line.accountName ?? ''}` : (line.accountName ?? line.accountId)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{line.description ?? ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(line.amount, currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {voidDeposit.isError ? (
        <p className="text-sm text-destructive" role="alert">{(voidDeposit.error as Error).message}</p>
      ) : null}

      <ConfirmDialog
        open={confirmVoid}
        onOpenChange={setConfirmVoid}
        title={tdd.voidTitle}
        description={tdd.voidDescription}
        confirmLabel={tdd.void}
        cancelLabel={tdd.cancel}
        variant="destructive"
        onConfirm={async () => {
          try {
            await voidDeposit.mutateAsync(id);
          } catch {
            // The error is shown on the page; close the dialog so it is visible.
          }
          setConfirmVoid(false);
        }}
      />
    </div>
  );
}
