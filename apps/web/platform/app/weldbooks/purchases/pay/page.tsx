/**
 * Pay bills (`/weldbooks/purchases/pay`): pick approved euro bills, the bank
 * account they are paid from and the execution date, and make one SEPA
 * credit-transfer file to upload in the bank's business portal. A supplier
 * without an IBAN is held back and listed. Bills in an exported file show
 * "Payment pending" until their bank lines arrive.
 */

import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Download, Loader2, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageColumn } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useCan } from '@weldsuite/permissions/react';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { RecordLink } from '@/components/object-panel/record-link';
import { accountingKeys, useAccountingBankAccounts } from '@/hooks/queries/use-accounting-queries';
import {
  isSepaBatchesAvailable,
  useCreatePaymentBatch,
  usePayableEurBills,
  usePendingBillMap,
} from '@/hooks/queries/use-weldbooks-receipts-queries';
import { accountingApi, type BankAccount } from '@/lib/api/domains/weldbooks';
import type { PaymentBatch } from '@/lib/api/domains/weldbooks-receipts';
import { plural } from '@/lib/i18n/plural';
import { getLocale } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { BatchesList } from './batches-list';
import { downloadBatchFile } from './download-batch-file';
import { batchErrorMessage, canCreateBatch, heldMessage, isSelectable, maskIban, selectedTotal } from './pay-model';

/** Active euro accounts with an IBAN: the ones a SEPA file can be paid from. */
export function payableAccounts(accounts: readonly BankAccount[]): BankAccount[] {
  return accounts.filter((account) => account.isActive !== false && (account.currency ?? 'EUR') === 'EUR' && !!account.iban);
}

export default function PayBillsPage() {
  // The bills, payments and bank lines a file touches open as stacked panels.
  useObjectPanelUrlSync('/weldbooks/purchases/pay');

  // The Rust backend only (`books-sepa-batches`); the route guard shows the same page for a direct URL.
  if (!isSepaBatchesAvailable()) return <EditionUnavailablePage />;
  return <PayBills />;
}

function PayBills() {
  const { t } = useI18n();
  const tp = t.weldbooksReceipts.pay;
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const canCreate = useCan('banking:create');
  const canDownload = useCan('banking:manage');
  const bills = usePayableEurBills();
  const pending = usePendingBillMap();
  const accountsQuery = useAccountingBankAccounts();
  const create = useCreatePaymentBatch();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bankAccountId, setBankAccountId] = useState('');
  const [executionDate, setExecutionDate] = useState(() => today());
  const [created, setCreated] = useState<PaymentBatch | null>(null);
  const [downloading, setDownloading] = useState(false);

  const rows = useMemo(() => bills.data ?? [], [bills.data]);
  const accounts = useMemo(() => payableAccounts(accountsQuery.data?.data ?? []), [accountsQuery.data]);
  const selectable = useMemo(() => rows.filter((bill) => isSelectable(bill.id, pending)), [rows, pending]);
  const total = selectedTotal(rows, selected);

  // The supplier's IBAN is on the contact; the cache shares it with the rest of WeldBooks.
  const contactIds = useMemo(() => [...new Set(rows.map((bill) => bill.contactId).filter(Boolean))], [rows]);
  const contacts = useQueries({
    queries: contactIds.map((id) => ({
      queryKey: accountingKeys.customers.detail(id),
      queryFn: () => accountingApi.getCustomer(id),
      staleTime: 60_000,
    })),
  });
  const ibanOf = useMemo(() => {
    const map = new Map<string, string | null>();
    contactIds.forEach((id, index) => map.set(id, contacts[index]?.data?.data?.iban ?? null));
    return map;
  }, [contactIds, contacts]);

  const allSelected = selectable.length > 0 && selectable.every((bill) => selected.has(bill.id));
  const someSelected = selectable.some((bill) => selected.has(bill.id));

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(selectable.map((bill) => bill.id)) : new Set());

  const makeBatch = () => {
    if (!canCreateBatch({ selected: selected.size, bankAccountId, executionDate }) || create.isPending) return;
    create.mutate(
      { bankAccountId, billIds: [...selected], executionDate },
      {
        onSuccess: (batch) => {
          setCreated(batch);
          setSelected(new Set());
        },
      },
    );
  };

  const download = async (batch: PaymentBatch) => {
    setDownloading(true);
    try {
      await downloadBatchFile(batch);
    } catch {
      toast.error(tp.downloadFailed);
    } finally {
      setDownloading(false);
    }
  };

  let list;
  if (bills.isError && !bills.data) {
    list = <ErrorState message={tp.loadFailed} onRetry={() => void bills.refetch()} />;
  } else if (!bills.data) {
    list = <PageLoader fullScreen={false} />;
  } else if (rows.length === 0) {
    list = <EmptyState icon={Receipt} title={tp.empty} description={tp.emptyDescription} />;
  } else {
    list = (
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label={tp.selectAll}
                  disabled={selectable.length === 0}
                />
              </TableHead>
              <TableHead>{tp.colDue}</TableHead>
              <TableHead>{tp.colSupplier}</TableHead>
              <TableHead>{tp.colBill}</TableHead>
              <TableHead>{tp.colIban}</TableHead>
              <TableHead className="text-right">{tp.colBalance}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((bill) => {
              const isPending = pending.has(bill.id);
              const iban = ibanOf.get(bill.contactId) ?? null;
              const number = bill.billNumber ?? bill.externalReference ?? tp.colBill;
              return (
                <TableRow key={bill.id} data-testid={`pay-row-${bill.id}`}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(bill.id)}
                      onCheckedChange={(checked) => toggle(bill.id, checked === true)}
                      aria-label={tp.selectRow.replace('{number}', number)}
                      disabled={isPending}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDate(bill.dueDate)}</TableCell>
                  <TableCell>
                    {bill.contactId ? (
                      <RecordLink type="weldbooks_contact" id={bill.contactId} label={bill.contactName ?? '—'} />
                    ) : (
                      (bill.contactName ?? '—')
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      <RecordLink type="bill" id={bill.id} icon={Receipt} label={number} />
                      {isPending ? <SoftBadge tone="warning">{tp.pendingChip}</SoftBadge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {iban ? maskIban(iban) : <span className="font-sans text-muted-foreground">{tp.noIban}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(bill.balanceDue ?? '0', 'EUR')}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  const errorText = create.isError ? batchErrorMessage(create.error, tp.errors) : null;
  const heldCodes: Readonly<Record<string, string>> = tp.heldCodes;

  return (
    <PageColumn className="space-y-8 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold leading-tight">{tp.title}</h1>
        <p className="text-sm text-muted-foreground">{tp.description}</p>
      </header>

      {created ? (
        <section aria-labelledby="created-title" className="space-y-3 rounded-xl border border-emerald-300/60 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="batch-created">
          <h2 id="created-title" className="text-base font-semibold">
            {tp.createdTitle}
          </h2>
          <p className="text-sm" role="status">
            {tp.createdBody
              .replace('{count}', String(created.paymentCount))
              .replace('{amount}', formatMoney(created.totalAmount, 'EUR'))
              .replace('{date}', formatDate(created.executionDate))}
          </p>
          {created.held.length > 0 ? (
            <div data-testid="batch-held">
              <InfoBanner variant="warning" title={tp.heldTitle}>
                <p className="text-xs">{tp.heldHint}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {created.held.map((held) => (
                    <li key={`${held.partyId ?? held.contactName}-${held.code}`}>
                      <strong>{held.contactName ?? '—'}</strong>: {heldMessage(held, heldCodes)}
                    </li>
                  ))}
                </ul>
              </InfoBanner>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {canDownload ? (
              <Button type="button" onClick={() => void download(created)} disabled={downloading} data-testid="batch-download">
                {downloading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                {tp.download}
              </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">{tp.downloadHint}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>
            {tp.another}
          </Button>
        </section>
      ) : (
        <section aria-labelledby="select-title" className="space-y-4">
          <div>
            <h2 id="select-title" className="text-base font-semibold">
              {tp.selectTitle}
            </h2>
            <p className="text-xs text-muted-foreground">{tp.selectHint}</p>
          </div>

          {list}

          {rows.length > 0 ? (
            <div className="space-y-4 rounded-xl border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pay-from">{tp.from}</Label>
                  <Select value={bankAccountId} onValueChange={setBankAccountId}>
                    <SelectTrigger id="pay-from">
                      <SelectValue placeholder={tp.fromPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name} ({maskIban(account.iban)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {accountsQuery.data && accounts.length === 0 ? <p className="text-xs text-muted-foreground">{tp.noAccounts}</p> : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pay-date">{tp.executionDate}</Label>
                  <Input id="pay-date" type="date" value={executionDate} onChange={(event) => setExecutionDate(event.target.value)} />
                </div>
              </div>

              {errorText ? (
                <p className="text-sm text-destructive" role="alert" data-testid="batch-error">
                  {errorText}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm tabular-nums" role="status" data-testid="pay-total">
                  {plural(selected.size, tp.selectedCount, getLocale())}
                  {' · '}
                  {tp.runningTotal.replace('{amount}', formatMoney(total, 'EUR'))}
                </p>
                {canCreate ? (
                  <Button
                    type="button"
                    onClick={makeBatch}
                    disabled={!canCreateBatch({ selected: selected.size, bankAccountId, executionDate }) || create.isPending}
                    data-testid="batch-create"
                  >
                    {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
                    {create.isPending ? tp.creating : tp.create}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      )}

      <BatchesList />
    </PageColumn>
  );
}
