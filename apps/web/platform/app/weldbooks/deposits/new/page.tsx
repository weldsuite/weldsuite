import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
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
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import {
  useBankAccounts,
  useCreateBankDeposit,
  useUndepositedPayments,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import type { Account } from '@/lib/api/domains/weldbooks';
import { maskedAccountNumber } from '../../banking/components/routing-number';
import {
  buildDepositInput,
  computeDepositTotals,
  depositBankAccounts,
  depositProblems,
  type OtherLineDraft,
} from '../deposit-math';

let nextLineKey = 0;
const newOtherLine = (): OtherLineDraft => ({ key: `line-${nextLineKey++}`, accountId: '', amount: '', description: '' });

/** Accounts that can hold an extra deposit line: Undeposited Funds and the bank itself can't. */
function otherLineAccounts(accounts: readonly Account[], bankLedgerAccountId: string | null | undefined): Account[] {
  return accounts
    .filter((a) => a.isActive !== false && a.id !== bankLedgerAccountId)
    .filter((a) => (a as Account & { systemRole?: string | null }).systemRole !== 'undeposited_funds')
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

export default function MakeDepositPage() {
  const { t } = useI18n();
  const td = t.weldbooksUs.banking.deposits;
  const tn = td.make;
  const methodLabels = t.accounting.paymentMethods;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { accountId?: string };
  const { can } = usePermissions();
  const { formatMoney, formatDate, today, entityCurrency } = useWeldbooksFormat();

  const undeposited = useUndepositedPayments();
  const accountsQuery = useBankAccounts();
  const ledgerQuery = useAccountingAccounts();
  const createDeposit = useCreateBankDeposit();

  const bankAccounts = useMemo(() => depositBankAccounts(accountsQuery.data?.data ?? []), [accountsQuery.data]);
  const payments = useMemo(() => undeposited.data ?? [], [undeposited.data]);
  const ledgerAccounts = useMemo(() => (ledgerQuery.data?.data ?? []) as Account[], [ledgerQuery.data]);

  const [bankAccountId, setBankAccountId] = useState(search.accountId ?? '');
  const [date, setDate] = useState(() => today());
  const [memo, setMemo] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [otherLines, setOtherLines] = useState<OtherLineDraft[]>([]);
  const [showProblems, setShowProblems] = useState(false);

  // Start on the default bank account once the list is known.
  useEffect(() => {
    if (bankAccountId || bankAccounts.length === 0) return;
    setBankAccountId((bankAccounts.find((a) => a.isDefault) ?? bankAccounts[0]).id);
  }, [bankAccountId, bankAccounts]);

  const bankAccount = bankAccounts.find((a) => a.id === bankAccountId);
  const chosen = payments.filter((p) => selected.has(p.paymentId));
  const totals = computeDepositTotals(chosen, otherLines);
  const problems = depositProblems({ bankAccountId, date, selectedCount: chosen.length, otherLines, totals });
  const lineAccounts = otherLineAccounts(ledgerAccounts, bankAccount?.ledgerAccountId);
  const allSelected = payments.length > 0 && payments.every((p) => selected.has(p.paymentId));

  const toggle = (paymentId: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(paymentId);
      else next.delete(paymentId);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(payments.map((p) => p.paymentId)) : new Set());
  const updateLine = (key: string, patch: Partial<OtherLineDraft>) =>
    setOtherLines((lines) => lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = () => {
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    createDeposit.mutate(
      buildDepositInput({ bankAccountId, date, memo, paymentIds: chosen.map((p) => p.paymentId), otherLines }),
      { onSuccess: (created) => navigate({ to: '/weldbooks/deposits/$id', params: { id: created.id } }) },
    );
  };

  if (undeposited.isLoading || accountsQuery.isLoading) return <PageLoader fullScreen={false} />;

  let paymentsBody: React.ReactNode;
  if (undeposited.isError) {
    paymentsBody = <p className="p-4 text-sm text-destructive" role="alert">{tn.loadFailed}</p>;
  } else if (payments.length === 0) {
    paymentsBody = <p className="p-4 text-sm text-muted-foreground" data-testid="no-undeposited">{tn.noPayments}</p>;
  } else {
    paymentsBody = (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => toggleAll(!!checked)}
                  aria-label={tn.selectAll}
                  data-testid="select-all-payments"
                />
              </TableHead>
              <TableHead>{tn.columns.date}</TableHead>
              <TableHead>{tn.columns.from}</TableHead>
              <TableHead>{tn.columns.method}</TableHead>
              <TableHead>{tn.columns.checkNumber}</TableHead>
              <TableHead>{tn.columns.reference}</TableHead>
              <TableHead className="text-right">{tn.columns.amount}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((p) => (
              <TableRow key={p.paymentId} data-state={selected.has(p.paymentId) ? 'selected' : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selected.has(p.paymentId)}
                    onCheckedChange={(checked) => toggle(p.paymentId, !!checked)}
                    aria-label={tn.selectPayment.replace('{from}', p.contactName ?? p.paymentId)}
                    data-testid={`select-payment-${p.paymentId}`}
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(p.date)}</TableCell>
                <TableCell>{p.contactName ?? '—'}</TableCell>
                <TableCell>
                  {p.paymentMethod && p.paymentMethod in methodLabels
                    ? methodLabels[p.paymentMethod as keyof typeof methodLabels]
                    : (p.paymentMethod ?? '—')}
                </TableCell>
                <TableCell>{p.checkNumber ?? ''}</TableCell>
                <TableCell className="max-w-[200px] truncate text-muted-foreground">{p.reference ?? ''}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(p.amount, entityCurrency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }


  const problemText: Record<(typeof problems)[number], string> = {
    bankAccount: tn.problems.bankAccount,
    date: tn.problems.date,
    nothing: tn.problems.nothing,
    otherLineAccount: tn.problems.otherLineAccount,
    otherLineAmount: tn.problems.otherLineAmount,
    total: tn.problems.total,
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild aria-label={tn.back}>
          <Link to="/weldbooks/deposits">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{tn.title}</h1>
          <p className="text-sm text-muted-foreground">{tn.subtitle}</p>
        </div>
      </div>

      {!can('banking:create') ? <p className="text-sm text-muted-foreground">{tn.noPermission}</p> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{tn.paymentsTitle}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {paymentsBody}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{tn.otherTitle}</CardTitle>
                <p className="text-xs text-muted-foreground">{tn.otherHint}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setOtherLines((lines) => [...lines, newOtherLine()])} data-testid="add-other-line">
                <Plus className="h-4 w-4" />
                {tn.addLine}
              </Button>
            </CardHeader>
            {otherLines.length > 0 ? (
              <CardContent className="space-y-3">
                {otherLines.map((line) => (
                  <div key={line.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.5fr_1fr_1.5fr_auto] sm:items-end" data-testid="other-line">
                    <div className="space-y-1">
                      <Label>{tn.columns.account}</Label>
                      <Select value={line.accountId} onValueChange={(value) => updateLine(line.key, { accountId: value })}>
                        <SelectTrigger aria-label={tn.columns.account} data-testid="other-line-account">
                          <SelectValue placeholder={tn.accountPlaceholder} />
                        </SelectTrigger>
                        <SelectContent>
                          {lineAccounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>{tn.columns.lineAmount}</Label>
                      <Input
                        inputMode="decimal"
                        value={line.amount}
                        placeholder="0.00"
                        onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                        aria-label={tn.columns.lineAmount}
                        data-testid="other-line-amount"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>{tn.columns.description}</Label>
                      <Input value={line.description} onChange={(e) => updateLine(line.key, { description: e.target.value })} maxLength={255} />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={tn.removeLine}
                      onClick={() => setOtherLines((lines) => lines.filter((l) => l.key !== line.key))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">{tn.signHint}</p>
              </CardContent>
            ) : null}
          </Card>
        </div>

        <Card className="h-fit lg:sticky lg:top-4">
          <CardHeader>
            <CardTitle className="text-base">{tn.depositTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="deposit-bank-account">{tn.bankAccount}</Label>
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger id="deposit-bank-account" data-testid="deposit-bank-account">
                  <SelectValue placeholder={tn.bankAccountPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.accountNumberLast4 ? ` · ${maskedAccountNumber(a.accountNumberLast4)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="deposit-date">{tn.date}</Label>
              <Input id="deposit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="deposit-memo">{tn.memo}</Label>
              <Input id="deposit-memo" value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} placeholder={tn.memoPlaceholder} />
            </div>

            <dl className="space-y-1 border-t pt-3 text-sm" data-testid="deposit-totals">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{tn.paymentsCount.replace('{count}', String(chosen.length))}</dt>
                <dd className="tabular-nums" data-testid="payments-total">{formatMoney(totals.paymentsTotal, entityCurrency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{tn.otherTotal}</dt>
                <dd className="tabular-nums" data-testid="other-total">{formatMoney(totals.otherTotal, entityCurrency)}</dd>
              </div>
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <dt>{tn.total}</dt>
                <dd className="tabular-nums" data-testid="deposit-total">{formatMoney(totals.total, entityCurrency)}</dd>
              </div>
            </dl>

            {showProblems && problems.length > 0 ? (
              <ul className="space-y-0.5 text-sm text-destructive" role="alert">
                {problems.map((p) => (
                  <li key={p}>{problemText[p]}</li>
                ))}
              </ul>
            ) : null}
            {createDeposit.isError ? (
              <p className="text-sm text-destructive" role="alert">{(createDeposit.error as Error).message || tn.failed}</p>
            ) : null}

            <Button
              className="w-full"
              onClick={submit}
              disabled={createDeposit.isPending || !can('banking:create')}
              data-testid="make-deposit"
            >
              {createDeposit.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {tn.submit}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
