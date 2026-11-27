/**
 * Credit tab of the contact panel (Rust only: `books-bank-processing`): the
 * money received from, or paid to, this contact that is not applied to a
 * document yet. Each row has Apply, which picks one of the contact's open
 * invoices or bills and applies the smaller of the credit and the balance.
 */

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ErrorBanner, ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useInfiniteAccountingBills, useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { useApplyPayment, useContactCredits } from '@/hooks/queries/use-weldbooks-processing-queries';
import type { ContactCredit } from '@/lib/api/domains/weldbooks-processing';
import { useI18n } from '@/lib/i18n/provider';
import { fromCents, toCents } from '@/lib/weldbooks/bank-link-math';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** Statuses of a document that cannot take a payment. */
const CLOSED_STATUSES = new Set(['draft', 'void', 'voided', 'cancelled', 'rejected', 'paid']);

interface OpenDocument {
  /** `invoice:<id>` or `bill:<id>`. */
  key: string;
  kind: 'invoice' | 'bill';
  id: string;
  number: string | null;
  balance: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
}

/** What Apply does with the picked document: the smaller of the credit and the balance, in cents. */
export function defaultApplyCents(credit: Pick<ContactCredit, 'unallocatedAmount'>, balance: string): number {
  const left = toCents(credit.unallocatedAmount);
  const open = toCents(balance);
  if (!Number.isFinite(left) || !Number.isFinite(open)) return 0;
  return Math.max(0, Math.min(left, open));
}

function ApplyCreditDialog({
  contactId,
  credit,
  onOpenChange,
}: Readonly<{ contactId: string; credit: ContactCredit | null; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const tc = t.weldbooksConnected.credit;
  const { formatMoney } = useWeldbooksFormat();
  const ids = useId();
  const apply = useApplyPayment();
  // Money received settles invoices, money sent settles bills.
  const kind: 'invoice' | 'bill' = credit?.type === 'received' ? 'invoice' : 'bill';
  const invoices = useInfiniteAccountingInvoices({ contactId }, { enabled: credit !== null && kind === 'invoice' });
  const bills = useInfiniteAccountingBills({ contactId }, { enabled: credit !== null && kind === 'bill' });
  const [documentKey, setDocumentKey] = useState('');
  const [amount, setAmount] = useState('');

  const documents = useMemo<OpenDocument[]>(() => {
    if (kind === 'invoice') {
      return (invoices.data?.rows ?? [])
        .filter((row) => !CLOSED_STATUSES.has(row.status) && Number(row.balanceDue) > 0)
        .map((row) => ({ key: `invoice:${row.id}`, kind: 'invoice', id: row.id, number: row.invoiceNumber, balance: row.balanceDue ?? '0' }));
    }
    return (bills.data?.rows ?? [])
      .filter((row) => !CLOSED_STATUSES.has(row.status) && Number(row.balanceDue) > 0)
      .map((row) => ({ key: `bill:${row.id}`, kind: 'bill', id: row.id, number: row.billNumber, balance: row.balanceDue ?? '0' }));
  }, [kind, invoices.data, bills.data]);

  useEffect(() => {
    setDocumentKey('');
    setAmount('');
    apply.reset();
    // Reset when another credit opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credit?.paymentId]);

  const picked = documents.find((doc) => doc.key === documentKey);
  const loading = kind === 'invoice' ? invoices.isLoading : bills.isLoading;
  const cents = toCents(amount);
  const maxCents = credit && picked ? defaultApplyCents(credit, picked.balance) : 0;
  const amountValid = Number.isFinite(cents) && cents > 0 && cents <= maxCents;

  const label = (doc: OpenDocument) =>
    (doc.kind === 'invoice' ? tc.invoice : tc.bill).replace('{number}', doc.number ?? tc.noNumber);

  const pick = (key: string) => {
    setDocumentKey(key);
    const doc = documents.find((candidate) => candidate.key === key);
    if (credit && doc) setAmount(fromCents(defaultApplyCents(credit, doc.balance)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!credit || !picked || !amountValid) return;
    apply.mutate(
      {
        paymentId: credit.paymentId,
        data: picked.kind === 'invoice' ? { invoiceId: picked.id, amount: fromCents(cents) } : { billId: picked.id, amount: fromCents(cents) },
      },
      {
        onSuccess: () => {
          toast.success(tc.applied);
          onOpenChange(false);
        },
        onError: (error) => toast.error(tc.applyFailed, { description: messageOf(error) || undefined }),
      },
    );
  };

  return (
    <Dialog open={credit !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="apply-credit-dialog">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{tc.dialogTitle}</DialogTitle>
            <DialogDescription>{tc.dialogDescription}</DialogDescription>
          </DialogHeader>

          {loading ? <InlineSpinner /> : null}
          {!loading && documents.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-open-documents">
              {tc.noDocuments}
            </p>
          ) : null}
          {documents.length > 0 ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor={`${ids}-doc`}>{tc.documentLabel}</Label>
                <Select value={documentKey} onValueChange={pick}>
                  <SelectTrigger id={`${ids}-doc`}>
                    <SelectValue placeholder={tc.documentPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {documents.map((doc) => (
                      <SelectItem key={doc.key} value={doc.key}>
                        {tc.documentOption
                          .replace('{label}', label(doc))
                          .replace('{balance}', formatMoney(doc.balance, credit?.currency ?? null))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${ids}-amount`}>{tc.amountLabel}</Label>
                <Input
                  id={`${ids}-amount`}
                  inputMode="decimal"
                  autoComplete="off"
                  className="max-w-[160px] tabular-nums"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          {apply.isError ? <ErrorBanner error={messageOf(apply.error) || tc.applyFailed} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tc.cancel}
            </Button>
            <Button type="submit" disabled={!amountValid || apply.isPending} data-testid="apply-credit-submit">
              {apply.isPending ? tc.applying : tc.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContactCreditTab({ contactId }: Readonly<{ contactId: string }>) {
  const { t } = useI18n();
  const tc = t.weldbooksConnected.credit;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { can } = usePermissions();
  const credits = useContactCredits(contactId);
  const [applying, setApplying] = useState<ContactCredit | null>(null);
  const rows = credits.data ?? [];

  if (credits.isError) return <ErrorState message={tc.loadFailed} onRetry={() => void credits.refetch()} />;
  if (credits.isLoading) {
    return (
      <div className="p-4">
        <InlineSpinner />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1 p-4 pb-2">
        <h3 className="text-sm font-semibold">{tc.title}</h3>
        <p className="text-xs text-muted-foreground">{tc.description}</p>
      </div>
      {rows.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">{tc.empty}</p> : null}
      <TabListScope>
        <div className="border-t border-gray-200/70 dark:border-border" data-testid="credit-rows">
          {rows.map((row) => (
            <TabListRow key={row.paymentId} label={row.reference ?? formatDate(row.date)}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{row.reference || formatDate(row.date)}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(row.date)} ·{' '}
                  {tc.leftOver
                    .replace('{left}', formatMoney(row.unallocatedAmount, row.currency))
                    .replace('{total}', formatMoney(row.amount, row.currency))}
                </span>
              </div>
              {can('banking:update') ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setApplying(row)}
                  data-testid={`apply-credit-${row.paymentId}`}
                >
                  {tc.apply}
                </Button>
              ) : null}
            </TabListRow>
          ))}
        </div>
      </TabListScope>
      <ApplyCreditDialog contactId={contactId} credit={applying} onOpenChange={(open) => !open && setApplying(null)} />
    </>
  );
}
