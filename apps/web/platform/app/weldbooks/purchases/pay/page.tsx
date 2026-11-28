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

type PayTexts = ReturnType<typeof useI18n>['t']['weldbooksReceipts']['pay'];
type WeldbooksFormat = ReturnType<typeof useWeldbooksFormat>;
type PayableBill = NonNullable<ReturnType<typeof usePayableEurBills>['data']>[number];

interface BillsTableProps {
  rows: readonly PayableBill[];
  selected: ReadonlySet<string>;
  /** The bills in a batch that is not paid yet (only `has` is read). */
  pending: ReadonlyMap<string, unknown>;
  ibanOf: ReadonlyMap<string, string | null>;
  selectable: readonly PayableBill[];
  allSelected: boolean;
  someSelected: boolean;
  onToggle: (id: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  tp: PayTexts;
  format: WeldbooksFormat;
}

/** The tri-state of the select-all box. */
function selectAllState(allSelected: boolean, someSelected: boolean): boolean | 'indeterminate' {
  if (allSelected) return true;
  return someSelected ? 'indeterminate' : false;
}

function BillsTable({ rows, selected, pending, ibanOf, selectable, allSelected, someSelected, onToggle, onToggleAll, tp, format }: Readonly<BillsTableProps>) {
  const { formatMoney, formatDate } = format;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={selectAllState(allSelected, someSelected)}
                onCheckedChange={(checked) => onToggleAll(checked === true)}
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
                    onCheckedChange={(checked) => onToggle(bill.id, checked === true)}
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

interface CreatedBatchPanelProps {
  batch: PaymentBatch;
  canDownload: boolean;
  downloading: boolean;
  onDownload: () => void;
  onAnother: () => void;
  tp: PayTexts;
  format: WeldbooksFormat;
}

function CreatedBatchPanel({ batch, canDownload, downloading, onDownload, onAnother, tp, format }: Readonly<CreatedBatchPanelProps>) {
  const { formatMoney, formatDate } = format;
  const heldCodes: Readonly<Record<string, string>> = tp.heldCodes;
  return (
    <section aria-labelledby="created-title" className="space-y-3 rounded-xl border border-emerald-300/60 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="batch-created">
      <h2 id="created-title" className="text-base font-semibold">
        {tp.createdTitle}
      </h2>
      <p className="text-sm" role="status">
        {tp.createdBody
          .replace('{count}', String(batch.paymentCount))
          .replace('{amount}', formatMoney(batch.totalAmount, 'EUR'))
          .replace('{date}', formatDate(batch.executionDate))}
      </p>
      {batch.held.length > 0 ? (
        <div data-testid="batch-held">
          <InfoBanner variant="warning" title={tp.heldTitle}>
            <p className="text-xs">{tp.heldHint}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {batch.held.map((held) => (
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
          <Button type="button" onClick={onDownload} disabled={downloading} data-testid="batch-download">
            {downloading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            {tp.download}
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">{tp.downloadHint}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onAnother}>
        {tp.another}
      </Button>
    </section>
  );
}

type BillsTableState = Omit<BillsTableProps, 'rows'>;

function BillsSection({ bills, rows, table }: Readonly<{ bills: ReturnType<typeof usePayableEurBills>; rows: readonly PayableBill[]; table: BillsTableState }>) {
  const { tp } = table;
  if (bills.isError && !bills.data) return <ErrorState message={tp.loadFailed} onRetry={() => void bills.refetch()} />;
  if (!bills.data) return <PageLoader fullScreen={false} />;
  if (rows.length === 0) return <EmptyState icon={Receipt} title={tp.empty} description={tp.emptyDescription} />;
  return <BillsTable rows={rows} {...table} />;
}

interface BatchFormProps {
  accounts: readonly BankAccount[];
  accountsLoaded: boolean;
  bankAccountId: string;
  onBankAccountChange: (id: string) => void;
  executionDate: string;
  onExecutionDateChange: (date: string) => void;
  errorText: string | null;
  selectedCount: number;
  total: string;
  canCreate: boolean;
  canSubmit: boolean;
  creating: boolean;
  onCreate: () => void;
  tp: PayTexts;
  format: WeldbooksFormat;
}

function BatchForm({
  accounts,
  accountsLoaded,
  bankAccountId,
  onBankAccountChange,
  executionDate,
  onExecutionDateChange,
  errorText,
  selectedCount,
  total,
  canCreate,
  canSubmit,
  creating,
  onCreate,
  tp,
  format,
}: Readonly<BatchFormProps>) {
  const { formatMoney } = format;
  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="pay-from">{tp.from}</Label>
          <Select value={bankAccountId} onValueChange={onBankAccountChange}>
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
          {accountsLoaded && accounts.length === 0 ? <p className="text-xs text-muted-foreground">{tp.noAccounts}</p> : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pay-date">{tp.executionDate}</Label>
          <Input id="pay-date" type="date" value={executionDate} onChange={(event) => onExecutionDateChange(event.target.value)} />
        </div>
      </div>

      {errorText ? (
        <p className="text-sm text-destructive" role="alert" data-testid="batch-error">
          {errorText}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm tabular-nums" role="status" data-testid="pay-total">
          {plural(selectedCount, tp.selectedCount, getLocale())}
          {' · '}
          {tp.runningTotal.replace('{amount}', formatMoney(total, 'EUR'))}
        </p>
        {canCreate ? (
          <Button
            type="button"
            onClick={onCreate}
            disabled={!canSubmit}
            data-testid="batch-create"
          >
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {creating ? tp.creating : tp.create}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PayBills() {
  const { t } = useI18n();
  const tp = t.weldbooksReceipts.pay;
  const format = useWeldbooksFormat();
  const { today } = format;
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

  const list = (
    <BillsSection
      bills={bills}
      rows={rows}
      table={{ selected, pending, ibanOf, selectable, allSelected, someSelected, onToggle: toggle, onToggleAll: toggleAll, tp, format }}
    />
  );

  const errorText = create.isError ? batchErrorMessage(create.error, tp.errors) : null;

  return (
    <PageColumn className="space-y-8 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold leading-tight">{tp.title}</h1>
        <p className="text-sm text-muted-foreground">{tp.description}</p>
      </header>

      {created ? (
        <CreatedBatchPanel
          batch={created}
          canDownload={canDownload}
          downloading={downloading}
          onDownload={() => void download(created)}
          onAnother={() => setCreated(null)}
          tp={tp}
          format={format}
        />
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
            <BatchForm
              accounts={accounts}
              accountsLoaded={Boolean(accountsQuery.data)}
              bankAccountId={bankAccountId}
              onBankAccountChange={setBankAccountId}
              executionDate={executionDate}
              onExecutionDateChange={setExecutionDate}
              errorText={errorText}
              selectedCount={selected.size}
              total={total}
              canCreate={canCreate}
              canSubmit={canCreateBatch({ selected: selected.size, bankAccountId, executionDate }) && !create.isPending}
              creating={create.isPending}
              onCreate={makeBatch}
              tp={tp}
              format={format}
            />
          ) : null}
        </section>
      )}

      <BatchesList />
    </PageColumn>
  );
}
